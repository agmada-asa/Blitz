/**
 * What a workspace chat turn does with each event its provider streams:
 * forwards it to the browser, saves it on the reply, and tracks the attempt's
 * state for the retries and compaction the chat route runs.
 */

import type { ConvexHttpClient } from "convex/browser"

import type { Id } from "../../../convex/_generated/dataModel.js"
import {
  MAX_PROVIDER_ACTIVITY_EVENTS,
  normalizeProviderActivity,
  type ProviderActivityEvent,
} from "../../provider-activity.ts"
import type { CardChatEvent } from "../card-chat.ts"
import type { createChatProgress } from "../chat-progress.ts"
import {
  addTurnNotice,
  bindWorkspaceTurn,
  dropReplacedMessages,
  recordCompaction,
  saveWorkspaceProviderEvents,
  type StartedTurn,
} from "./functions.ts"

/** Writes one event to the browser stream. */
export type SendEvent = (value: unknown) => void

/** The reply a turn writes to. */
type ReplyIds = {
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
}

/**
 * Keeps a reply's tool activity, sends each change to the browser at once,
 * and saves the list at most every 250 ms with one write in flight.
 *
 * @param client - Convex client for the personal deployment.
 * @param reply - The reply the activity belongs to.
 * @param send - Writes to the browser stream.
 */
export function createActivityLog(
  client: ConvexHttpClient,
  reply: ReplyIds,
  send: SendEvent
) {
  let events: ProviderActivityEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined

  /** Persists a coalesced snapshot of tool lifecycle records without blocking provider output. */
  const save = async (): Promise<void> => {
    timer = undefined
    const snapshot = events.map((event) => ({ ...event }))
    pending = client
      .mutation(saveWorkspaceProviderEvents, { ...reply, events: snapshot })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        pending = undefined
        if (JSON.stringify(events) !== JSON.stringify(snapshot) && !timer)
          timer = setTimeout(() => void save(), 250)
      })
    await pending
  }

  return {
    /** The activity so far, newest last. */
    get events(): readonly ProviderActivityEvent[] {
      return events
    },
    /** Adds or updates one tool's record and sends it to connected clients. */
    append(event: ProviderActivityEvent): void {
      const existing = events.findIndex((item) => item.id === event.id)
      if (existing >= 0) events[existing] = event
      else events = [...events, event].slice(-MAX_PROVIDER_ACTIVITY_EVENTS)
      send({ type: "activity", event })
      if (!timer && !pending) timer = setTimeout(() => void save(), 250)
    },
    /** Cancels the waiting save, lets the one in flight finish, and saves the final list. */
    async flush(): Promise<void> {
      if (timer) clearTimeout(timer)
      await pending
      if (events.length) await save()
    },
  }
}

/** One reply's tool activity log. */
export type ActivityLog = ReturnType<typeof createActivityLog>

/** What the chat route needs to know about the provider's attempts so far. */
export type AttemptState = {
  /** Whether the runtime accepted the current attempt. */
  accepted: boolean
  /** Runtime thread of the accepted attempt, for compacting after an overflow. */
  threadId?: string
  /** Reply text the current attempt has streamed. */
  text: string
  /** Whether Blitz's compaction ran before the current attempt. */
  requestedCompacted: boolean
  /** Whether the runtime compacted by itself during the reply. */
  runtimeCompacted: boolean
  /** How a compaction Blitz asks for is recorded: before a turn, or after an overflow. */
  compactionOrigin: "auto" | "overflow"
  /** Saving the accepted attempt's runtime IDs; awaited before a failure is saved. */
  binding?: Promise<unknown>
}

/**
 * Builds the provider event handler for one turn.
 *
 * Text and working notes stream to the browser and the reply's progress;
 * tool activity goes to `activity`; notices, compactions, and a redo's
 * rewind are saved beside the reply without holding up the stream.
 *
 * @param options.teach - Whether this is a Teach session, which records its compactions.
 * @param options.redo - The reply a redo replaces, removed once the runtime rewinds.
 * @returns The handler, the attempt state it updates, `startAttempt` to call
 *   before each attempt, and `settle` to await the bookkeeping writes.
 */
export function createTurnEvents(options: {
  client: ConvexHttpClient
  reply: ReplyIds
  providerId: string
  teach: boolean
  redo: StartedTurn["redo"]
  send: SendEvent
  progress: ReturnType<typeof createChatProgress>
  activity: ActivityLog
}) {
  const { client, reply, providerId, send, progress, activity } = options
  const state: AttemptState = {
    accepted: false,
    text: "",
    requestedCompacted: false,
    runtimeCompacted: false,
    compactionOrigin: "auto",
  }
  /** Notice, compaction, and redo writes made while the reply streams; awaited before it ends. */
  const writes: Promise<unknown>[] = []

  /** Tracks one bookkeeping write, logging a failure instead of failing the reply. */
  const track = (write: Promise<unknown>, label: string): void => {
    writes.push(
      write.catch((writeError: unknown) =>
        console.warn(label, {
          message:
            writeError instanceof Error ? writeError.message : "Unknown error",
        })
      )
    )
  }

  /** Handles one provider event. */
  const onEvent = (event: CardChatEvent): void => {
    const recorded = normalizeProviderActivity(event, activity.events)
    if (recorded) activity.append(recorded)
    if (event.type === "notice") {
      send({ type: "notice", notice: event.notice })
      track(
        client.mutation(addTurnNotice, { ...reply, notice: event.notice }),
        "Workspace chat could not save a notice"
      )
      return
    }
    if (event.type === "compacted") {
      if (event.origin === "requested") state.requestedCompacted = true
      else state.runtimeCompacted = true
      if (options.teach)
        track(
          client.mutation(recordCompaction, {
            ...reply,
            origin:
              event.origin === "requested" ? state.compactionOrigin : "runtime",
            ...(event.beforeTokens !== undefined
              ? { beforeTokens: event.beforeTokens }
              : {}),
          }),
          "Teach could not record a compaction"
        )
      return
    }
    if (event.type === "rewound") {
      // The runtime dropped the replaced turn; the transcript follows.
      if (options.redo)
        track(
          client.mutation(dropReplacedMessages, {
            chatId: reply.chatId,
            activeMessageId: reply.messageId,
            messageIds: options.redo.replacedMessageIds,
          }),
          "Teach could not remove the replaced reply"
        )
      return
    }
    if (event.type === "turn-started") {
      state.accepted = true
      state.threadId = event.threadId
      state.binding = client
        .mutation(bindWorkspaceTurn, {
          ...reply,
          providerId,
          providerSessionId: event.threadId,
          providerTurnId: event.turnId,
          ...(providerId === "codex"
            ? { codexThreadId: event.threadId, codexTurnId: event.turnId }
            : {}),
        })
        .catch((bindingError: unknown) => {
          console.error("Workspace chat could not save provider IDs", {
            message:
              bindingError instanceof Error
                ? bindingError.message
                : "Unknown persistence error",
          })
        })
      return
    }
    if (event.type === "thought-delta") {
      progress.appendThought(event.delta)
      send({ type: "thought-delta", text: event.delta })
    }
    if (event.type === "text-delta") {
      state.text += event.delta
      progress.append(event.delta)
      send({ type: "delta", text: event.delta })
    }
  }

  return {
    state,
    onEvent,
    /** Resets the per-attempt state before the provider is asked again. */
    startAttempt(): void {
      state.accepted = false
      state.text = ""
      state.requestedCompacted = false
    },
    /** Waits for every notice, compaction, and redo write. */
    settle(): Promise<unknown> {
      return Promise.all(writes)
    },
  }
}
