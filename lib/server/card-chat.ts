/**
 * Runs one bounded text turn over the local Codex app-server and defines the
 * event, result, and error types every provider adapter shares.
 *
 * It starts or resumes a persistent Codex thread, streams typed events, and
 * always closes the local transport after the turn. The names keep their
 * original card chat prefix; workspace chat, Teach, research, and project
 * agents all use them.
 */

import { isAbsolute } from "node:path"
import {
  CodexAppServerClient,
  type CodexAppServerEvent,
  type CodexApprovalHandler,
  type CodexNotification,
  type CodexResumeThreadOptions,
  type CodexServerRequest,
  type CodexStartThreadOptions,
  type CodexStartTurnOptions,
  type CodexThreadResponse,
  type CodexTurn,
  type CodexTurnResponse,
  type CodexWebSearchMode,
  type CodexSandboxMode,
} from "./codex-app-server.ts"

/** Maximum assistant text plus raced delta text retained for one turn. */
export const MAX_CARD_CHAT_STREAM_TEXT_LENGTH = 250_000
/** Default wall-clock limit for one text turn. */
export const DEFAULT_CARD_CHAT_TIMEOUT_MS = 60_000
const CLEANUP_TIMEOUT_MS = 1_000
const MAX_CARD_CHAT_RACE_DELTA_COUNT = 4_096
const MAX_CARD_CHAT_RACE_TURN_COUNT = 128

/** Generic bounded text-turn input reusable by server-side generation jobs. */
export interface CodexTextTurnRequest {
  /** Approval policy enforced for new and resumed provider threads. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never"
  /** Explicit sandbox mode reasserted on both thread and turn requests. */
  readonly sandbox?: CodexSandboxMode
  /** Application-owned instructions sent through Codex's developer channel. */
  readonly developerInstructions?: string
  /** Optional native image inputs appended to the user text item. */
  readonly images?: readonly { type: "image"; url: string }[]
  /** Explicit absolute Blitz-owned workspace for local Codex. */
  readonly workspaceDirectory: string
  /** Already prepared, bounded prompt text. */
  readonly prompt: string
  /** Avoids retaining disposable generation sessions in Codex history. */
  readonly ephemeral?: boolean
  /** Optional model override; omitted to preserve Codex configuration. */
  readonly model?: string
  /** Optional reasoning effort override; omitted to preserve configuration. */
  readonly effort?: string
  /** Optional process-scoped hosted search mode for this turn. */
  readonly webSearchMode?: CodexWebSearchMode
  /** Existing persistent Codex thread to resume, when available. */
  readonly threadId?: string
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Optional wall-clock deadline for the complete turn. */
  readonly timeoutMs?: number
}

/** Typed text streamed from an agent-message delta notification. */
export interface CardChatTextDeltaEvent {
  /** Discriminator for text streaming. */
  readonly type: "text-delta"
  /** Server-issued thread identifier. */
  readonly threadId: string
  /** Server-issued turn identifier. */
  readonly turnId: string
  /** Incremental assistant text. */
  readonly delta: string
}

/** Typed thought or reasoning text streamed from the provider. */
export interface CardChatThoughtDeltaEvent {
  /** Discriminator for thought streaming. */
  readonly type: "thought-delta"
  /** Server-issued thread identifier. */
  readonly threadId: string
  /** Server-issued turn identifier. */
  readonly turnId: string
  /** Incremental thought text. */
  readonly delta: string
}

/** Typed lifecycle event emitted once Codex accepts a turn. */
export interface CardChatTurnStartedEvent {
  /** Discriminator for early persistence of the conversation identifiers. */
  readonly type: "turn-started"
  /** Server-issued thread identifier. */
  readonly threadId: string
  /** Server-issued turn identifier. */
  readonly turnId: string
}

/** Typed activity event preserving the richer app-server notification. */
export interface CardChatActivityEvent {
  /** Discriminator for non-text streamed activity. */
  readonly type: "activity"
  /** Original notification for future tool/activity consumers. */
  readonly notification: CodexNotification
}

/** Typed activity event for server requests such as approval prompts. */
export interface CardChatServerRequestEvent {
  /** Discriminator for surfaced server requests. */
  readonly type: "activity"
  /** Original server request for future approval UI wiring. */
  readonly serverRequest: CodexServerRequest
}

/** Typed successful turn completion event. */
export interface CardChatCompletionEvent {
  /** Discriminator for terminal success. */
  readonly type: "completed"
  /** Server-issued thread identifier. */
  readonly threadId: string
  /** Server-issued turn identifier. */
  readonly turnId: string
  /** Actual server-reported terminal status. */
  readonly status: "completed"
  /** Complete text observed from streamed deltas. */
  readonly text: string
  /** Complete accumulated thought or reasoning trace. */
  readonly thought?: string
  /** Elapsed turn duration in milliseconds. */
  readonly durationMs?: number
}

/** Reasons a text turn can fail before producing a completion. */
export type CardChatFailureReason =
  | "invalid-input"
  | "aborted"
  | "timeout"
  | "transport"
  | "provider-overloaded"
  | "usage-limit"
  | "rate-limit"
  | "turn-failed"
  | "turn-interrupted"

/** Typed terminal failure event. */
export interface CardChatErrorEvent {
  /** Discriminator for terminal failure. */
  readonly type: "error"
  /** Failure details safe for the caller to show or log. */
  readonly error: CardChatError
}

/** Every event emitted while a text turn is running. */
export type CardChatEvent =
  | CardChatTurnStartedEvent
  | CardChatTextDeltaEvent
  | CardChatThoughtDeltaEvent
  | CardChatActivityEvent
  | CardChatServerRequestEvent
  | CardChatCompletionEvent
  | CardChatErrorEvent

/** Successful result returned after a server-confirmed completed turn. */
export interface CardChatResult {
  /** Persistent thread identifier for a later question. */
  readonly threadId: string
  /** Completed turn identifier. */
  readonly turnId: string
  /** Complete text observed from streamed deltas. */
  readonly text: string
  /** Complete accumulated thought or reasoning trace. */
  readonly thought?: string
  /** Elapsed turn duration in milliseconds. */
  readonly durationMs?: number
}

/** Stable error for invalid input, cancellation, timeout, provider limits, or turn failure. */
export class CardChatError extends Error {
  /** Machine-readable reason for the failure. */
  readonly reason: CardChatFailureReason
  /** Optional underlying transport or provider error, retained for diagnostics. */
  readonly cause?: unknown

  /** Creates a safe card-chat error without including source content. */
  constructor(reason: CardChatFailureReason, message: string, cause?: unknown) {
    super(message)
    this.name = "CardChatError"
    this.reason = reason
    this.cause = cause
  }
}

/** Narrow client contract allowing lifecycle tests without a real child. */
export interface CardChatTransport {
  /** Starts a thread with explicit safe policy defaults. */
  startThread(options?: CodexStartThreadOptions): Promise<CodexThreadResponse>
  /** Resumes a persisted thread with explicit safe policy defaults. */
  resumeThread(
    threadId: string,
    options?: CodexResumeThreadOptions
  ): Promise<CodexThreadResponse>
  /** Starts the user-authored text turn. */
  startTurn(
    threadId: string,
    options: CodexStartTurnOptions
  ): Promise<CodexTurnResponse>
  /** Interrupts an active turn. */
  interruptTurn(threadId: string, turnId: string): Promise<void>
  /** Subscribes to app-server notifications and lifecycle events. */
  onEvent(listener: (event: CodexAppServerEvent) => void): () => void
  /** Closes the local app-server process. */
  close(): Promise<void>
}

/** Injectable transport factory used by production and lifecycle tests. */
export type CardChatTransportFactory = (options: {
  workspaceDirectory: string
  signal?: AbortSignal
  webSearchMode?: CodexWebSearchMode
}) => CardChatTransport | Promise<CardChatTransport>

/** Options controlling event delivery and local transport construction. */
export interface CardChatRunOptions {
  /** Receives text, activity, completion, and error events in arrival order. */
  readonly onEvent?: (event: CardChatEvent) => void
  /** Injectable app-server client factory. */
  readonly createTransport?: CardChatTransportFactory
  /** Resolves one native Codex request for the current turn. */
  readonly approvalHandler?: CodexApprovalHandler
}

/** Reads an object-like notification parameter without trusting its contents. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

/** Parses text or thought delta from Codex agentMessage, reasoning, or summary notifications. */
function parseDelta(
  notification: CodexNotification,
  itemsById?: Map<string, { type: string; phase?: string }>
):
  | { threadId: string; turnId: string; delta: string; isThought: boolean }
  | undefined {
  const method = notification.method
  const isReasoningMethod =
    method === "item/reasoning/textDelta" ||
    method === "item/reasoning/summaryTextDelta"
  const isAgentMessageDelta = method === "item/agentMessage/delta"
  if (!isReasoningMethod && !isAgentMessageDelta) return undefined

  const params = record(notification.params)
  if (
    typeof params?.threadId !== "string" ||
    typeof params.turnId !== "string" ||
    typeof params.delta !== "string"
  ) {
    return undefined
  }
  const itemId = typeof params.itemId === "string" ? params.itemId : undefined
  const item = itemId && itemsById ? itemsById.get(itemId) : undefined
  const isThought =
    isReasoningMethod ||
    item?.phase === "commentary" ||
    item?.type === "reasoning"

  return {
    threadId: params.threadId,
    turnId: params.turnId,
    delta: params.delta,
    isThought: Boolean(isThought),
  }
}

/** Parses the installed turn/completed notification shape. */
function parseCompletion(
  notification: CodexNotification
): { threadId: string; turn: CodexTurn } | undefined {
  if (notification.method !== "turn/completed") return undefined
  const params = record(notification.params)
  const turn = record(params?.turn)
  if (
    typeof params?.threadId !== "string" ||
    typeof turn?.id !== "string" ||
    typeof turn.status !== "string"
  ) {
    return undefined
  }
  return { threadId: params.threadId, turn: turn as CodexTurn }
}

/** Maps verified Codex limit codes to safe recovery copy without exposing raw provider messages. */
function codexLimitError(error: unknown): CardChatError | undefined {
  const providerError = record(error)
  switch (providerError?.codexErrorInfo) {
    case "serverOverloaded":
      return new CardChatError(
        "provider-overloaded",
        "The selected model is at capacity. Try again shortly or choose another model in Settings.",
        providerError
      )
    case "usageLimitExceeded":
      return new CardChatError(
        "usage-limit",
        "You've reached the selected provider's usage limit. Wait for it to reset or choose another provider in Settings.",
        providerError
      )
    case "rateLimitExceeded":
      return new CardChatError(
        "rate-limit",
        "Too many requests to the selected provider. Wait a moment, then try again.",
        providerError
      )
    default:
      return undefined
  }
}

/** Extracts authoritative assistant text from completed turn items when present. */
function extractTurnText(turn: CodexTurn): string | undefined {
  if (!Array.isArray(turn.items)) return undefined
  const finalAnswers = turn.items
    .map((item) => record(item))
    .filter(
      (item): item is Record<string, unknown> =>
        item?.type === "agentMessage" &&
        item.phase !== "commentary" &&
        typeof item.text === "string"
    )
    .map((item) => item.text as string)
  if (finalAnswers.length > 0) return finalAnswers.join("\n")

  const messages = turn.items
    .map((item) => record(item))
    .filter(
      (item): item is Record<string, unknown> =>
        item?.type === "agentMessage" && typeof item.text === "string"
    )
    .map((item) => item.text as string)
  return messages.length > 0 ? messages.join("\n") : undefined
}

/** Extracts authoritative assistant thoughts or commentary from completed turn items. */
function extractTurnThoughts(turn: CodexTurn): string | undefined {
  if (!Array.isArray(turn.items)) return undefined
  const thoughts: string[] = []
  for (const raw of turn.items) {
    const item = record(raw)
    if (!item) continue
    if (
      item.type === "agentMessage" &&
      item.phase === "commentary" &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      thoughts.push(item.text.trim())
    }
    if (item.type === "reasoning") {
      if (Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (typeof s === "string" && s.trim()) thoughts.push(s.trim())
        }
      }
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c === "string" && c.trim()) thoughts.push(c.trim())
          else if (
            typeof c === "object" &&
            c &&
            "text" in c &&
            typeof (c as { text: unknown }).text === "string"
          ) {
            const t = (c as { text: string }).text.trim()
            if (t) thoughts.push(t)
          }
        }
      }
    }
  }
  return thoughts.length > 0 ? thoughts.join("\n\n") : undefined
}

/** Runs one bounded text turn and streams its typed lifecycle events. */
export async function runCodexTextTurn(
  request: CodexTextTurnRequest,
  options: CardChatRunOptions = {}
): Promise<CardChatResult> {
  if (!request.workspaceDirectory || !isAbsolute(request.workspaceDirectory)) {
    throw new CardChatError(
      "invalid-input",
      "Card chat requires an explicitly supplied absolute workspaceDirectory"
    )
  }
  if (request.threadId !== undefined && !request.threadId.trim()) {
    throw new CardChatError("invalid-input", "threadId must not be empty")
  }
  if (!request.prompt.trim()) {
    throw new CardChatError(
      "invalid-input",
      "Blitz text turn prompt must not be empty"
    )
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_CARD_CHAT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new CardChatError(
      "invalid-input",
      "Card chat timeoutMs must be a positive integer"
    )
  }

  const createTransport =
    options.createTransport ??
    ((transportOptions) =>
      CodexAppServerClient.connect({
        workspaceDirectory: transportOptions.workspaceDirectory,
        approvalHandler: options.approvalHandler,
        ...(transportOptions.webSearchMode === undefined
          ? {}
          : { webSearchMode: transportOptions.webSearchMode }),
      }))
  const emit = options.onEvent ?? (() => {})
  let client: CardChatTransport | undefined
  let lateClient: Promise<CardChatTransport> | undefined
  let unsubscribe: (() => void) | undefined
  let threadId: string | undefined
  let turnId: string | undefined
  let text = ""
  let thought = ""
  const startTime = Date.now()
  const itemsById = new Map<string, { type: string; phase?: string }>()
  let finished = false
  let cancelReason: CardChatError | undefined
  let resolveCancellation: ((error: CardChatError) => void) | undefined
  const cancellation = new Promise<never>((_, reject) => {
    resolveCancellation = reject
  })
  void cancellation.catch(() => undefined)
  const completionByTurn = new Map<string, CodexTurn>()
  const deltasByTurn = new Map<
    string,
    Array<{ delta: string; isThought: boolean }>
  >()
  let bufferedTextLength = 0
  let bufferedDeltaCount = 0
  let resolveCompletion: ((result: CardChatResult) => void) | undefined
  const completion = new Promise<CardChatResult>((resolve) => {
    resolveCompletion = resolve
  })

  /** Emits one typed event while isolating consumer callback failures. */
  const emitEvent = (event: CardChatEvent): void => {
    try {
      emit(event)
    } catch {
      // Event consumers cannot corrupt transport cleanup or completion state.
    }
  }

  /** Fails the pending run once and wakes all cancellation races. */
  const cancel = (error: CardChatError): void => {
    if (finished || cancelReason) return
    cancelReason = error
    resolveCancellation?.(error)
  }

  /** Resolves a server-confirmed completed turn once, despite duplicate events. */
  const complete = (status: string, completedTurn?: CodexTurn): void => {
    if (finished || !threadId || !turnId) return
    if (status !== "completed") {
      const providerError = record(completedTurn?.error)
      const limitError =
        status === "failed" ? codexLimitError(providerError) : undefined
      if (limitError) {
        cancel(limitError)
        return
      }
      const reason =
        status === "interrupted" ? "turn-interrupted" : "turn-failed"
      cancel(new CardChatError(reason, `Blitz turn ${status}`, providerError))
      return
    }
    const authoritativeText = completedTurn
      ? extractTurnText(completedTurn)
      : undefined
    if (authoritativeText !== undefined) {
      if (authoritativeText.length > MAX_CARD_CHAT_STREAM_TEXT_LENGTH) {
        cancel(
          new CardChatError(
            "transport",
            "Blitz assistant output exceeded the configured limit"
          )
        )
        return
      }
      text = authoritativeText
    }
    if (!text.trim()) {
      cancel(
        new CardChatError(
          "turn-failed",
          "Blitz completed without assistant text"
        )
      )
      return
    }
    const authoritativeThoughts = completedTurn
      ? extractTurnThoughts(completedTurn)
      : undefined
    const finalThought =
      authoritativeThoughts || (thought.trim() ? thought : undefined)
    const durationMs =
      typeof completedTurn?.durationMs === "number" &&
      completedTurn.durationMs >= 0
        ? completedTurn.durationMs
        : Date.now() - startTime
    finished = true
    const result: CardChatResult = {
      threadId,
      turnId,
      text,
      ...(finalThought ? { thought: finalThought } : {}),
      durationMs,
    }
    emitEvent({ ...result, type: "completed", status: "completed" })
    resolveCompletion?.(result)
  }

  /** Flushes notifications that raced the turn/start response. */
  const flushTurn = (): void => {
    if (!threadId || !turnId) return
    const key = `${threadId}\0${turnId}`
    for (const item of deltasByTurn.get(key) ?? []) {
      bufferedTextLength -= item.delta.length
      bufferedDeltaCount -= 1
      if (item.isThought) {
        if (
          thought.length + item.delta.length <=
          MAX_CARD_CHAT_STREAM_TEXT_LENGTH
        ) {
          thought += item.delta
          emitEvent({
            type: "thought-delta",
            threadId,
            turnId,
            delta: item.delta,
          })
        }
      } else {
        if (
          text.length + item.delta.length >
          MAX_CARD_CHAT_STREAM_TEXT_LENGTH
        ) {
          cancel(
            new CardChatError(
              "transport",
              "Blitz assistant output exceeded the configured limit"
            )
          )
          return
        }
        text += item.delta
        emitEvent({ type: "text-delta", threadId, turnId, delta: item.delta })
      }
    }
    deltasByTurn.delete(key)
    const completedTurn = completionByTurn.get(key)
    if (completedTurn) {
      completionByTurn.delete(key)
      complete(completedTurn.status ?? "failed", completedTurn)
    }
  }

  /** Routes every app-server event into typed card-chat behavior. */
  const handleTransportEvent = (event: CodexAppServerEvent): void => {
    if (event.type === "notification") {
      const notificationParams = record(event.notification.params)
      const notificationThreadId =
        typeof notificationParams?.threadId === "string"
          ? notificationParams.threadId
          : undefined
      if (threadId && notificationThreadId && notificationThreadId !== threadId)
        return
      emitEvent({ type: "activity", notification: event.notification })
      if (event.notification.method === "item/started") {
        const item = record(notificationParams?.item)
        if (typeof item?.id === "string" && typeof item.type === "string") {
          itemsById.set(item.id, {
            type: item.type,
            phase: typeof item.phase === "string" ? item.phase : undefined,
          })
        }
      }
      const delta = parseDelta(event.notification, itemsById)
      if (delta) {
        const key = `${delta.threadId}\0${delta.turnId}`
        if (threadId === delta.threadId && turnId === delta.turnId) {
          if (delta.isThought) {
            if (
              thought.length + delta.delta.length <=
              MAX_CARD_CHAT_STREAM_TEXT_LENGTH
            ) {
              thought += delta.delta
              emitEvent({
                type: "thought-delta",
                threadId: delta.threadId,
                turnId: delta.turnId,
                delta: delta.delta,
              })
            }
          } else {
            if (
              text.length + delta.delta.length >
              MAX_CARD_CHAT_STREAM_TEXT_LENGTH
            ) {
              cancel(
                new CardChatError(
                  "transport",
                  "Blitz assistant output exceeded the configured limit"
                )
              )
              return
            }
            text += delta.delta
            emitEvent({
              type: "text-delta",
              threadId: delta.threadId,
              turnId: delta.turnId,
              delta: delta.delta,
            })
          }
        } else {
          if (
            delta.delta.length === 0 ||
            bufferedTextLength + text.length + delta.delta.length >
              MAX_CARD_CHAT_STREAM_TEXT_LENGTH ||
            bufferedDeltaCount >= MAX_CARD_CHAT_RACE_DELTA_COUNT
          ) {
            if (
              bufferedTextLength + text.length + delta.delta.length >
                MAX_CARD_CHAT_STREAM_TEXT_LENGTH ||
              bufferedDeltaCount >= MAX_CARD_CHAT_RACE_DELTA_COUNT
            ) {
              cancel(
                new CardChatError(
                  "transport",
                  "Blitz assistant output exceeded the configured limit"
                )
              )
            }
            return
          }
          const pending = deltasByTurn.get(key) ?? []
          pending.push({ delta: delta.delta, isThought: delta.isThought })
          deltasByTurn.set(key, pending)
          bufferedTextLength += delta.delta.length
          bufferedDeltaCount += 1
        }
      }
      const completed = parseCompletion(event.notification)
      if (completed) {
        const key = `${completed.threadId}\0${completed.turn.id}`
        if (threadId === completed.threadId && turnId === completed.turn.id) {
          complete(completed.turn.status ?? "failed", completed.turn)
        } else {
          if (completionByTurn.size >= MAX_CARD_CHAT_RACE_TURN_COUNT) {
            cancel(
              new CardChatError(
                "transport",
                "Blitz emitted too many raced turn completions"
              )
            )
            return
          }
          completionByTurn.set(key, completed.turn)
        }
      }
      return
    }
    if (event.type === "process-error" || event.type === "protocol-error") {
      cancel(new CardChatError("transport", event.error.message, event.error))
      return
    }
    if (event.type === "process-closed") {
      cancel(new CardChatError("transport", "Blitz provider process closed"))
      return
    }
    if (event.type === "server-request") {
      emitEvent({ type: "activity", serverRequest: event.request })
    }
  }

  /** Races an app-server operation against cancellation without leaking late clients. */
  const raceCancellation = async <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, cancellation])

  const timer = setTimeout(
    () =>
      cancel(
        new CardChatError("timeout", `Card chat timed out after ${timeoutMs}ms`)
      ),
    timeoutMs
  )
  const onAbort = (): void =>
    cancel(new CardChatError("aborted", "Card chat was aborted"))
  if (request.signal?.aborted) onAbort()
  else request.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (cancelReason) throw cancelReason
    lateClient = Promise.resolve(
      createTransport({
        workspaceDirectory: request.workspaceDirectory,
        signal: request.signal,
        ...(request.webSearchMode === undefined
          ? {}
          : { webSearchMode: request.webSearchMode }),
      })
    )
    lateClient
      .then((candidate) => {
        if (client) return
        if (cancelReason || finished) void candidate.close()
        else client = candidate
      })
      .catch(() => {
        // The raced operation reports its own error below.
      })
    client = await raceCancellation(lateClient)
    if (cancelReason) throw cancelReason
    unsubscribe = client.onEvent(handleTransportEvent)
    const threadOptions: CodexStartThreadOptions = {
      approvalPolicy: request.approvalPolicy ?? "on-request",
      sandbox: request.sandbox ?? "read-only",
      ...(request.developerInstructions
        ? { developerInstructions: request.developerInstructions }
        : {}),
      ...(request.ephemeral === undefined
        ? {}
        : { ephemeral: request.ephemeral }),
      ...(request.model === undefined ? {} : { model: request.model }),
    }
    const resumeOptions: CodexResumeThreadOptions = {
      approvalPolicy: request.approvalPolicy ?? "on-request",
      sandbox: request.sandbox ?? "read-only",
      ...(request.developerInstructions
        ? { developerInstructions: request.developerInstructions }
        : {}),
      ...(request.model === undefined ? {} : { model: request.model }),
    }
    const thread = request.threadId
      ? await raceCancellation(
          client.resumeThread(request.threadId, resumeOptions)
        )
      : await raceCancellation(client.startThread(threadOptions))
    threadId = thread.thread.id
    const turn = await raceCancellation(
      client.startTurn(threadId, {
        text: request.prompt,
        approvalPolicy: request.approvalPolicy ?? "on-request",
        sandboxPolicy:
          request.sandbox === "danger-full-access"
            ? { type: "dangerFullAccess" }
            : request.sandbox === "workspace-write"
              ? {
                  type: "workspaceWrite",
                  writableRoots: [request.workspaceDirectory],
                  networkAccess: false,
                  excludeSlashTmp: true,
                  excludeTmpdirEnvVar: true,
                }
              : { type: "readOnly", networkAccess: false },
        ...(request.images?.length ? { images: request.images } : {}),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.effort === undefined ? {} : { effort: request.effort }),
      })
    )
    turnId = turn.turn.id
    emitEvent({ type: "turn-started", threadId, turnId })
    flushTurn()
    if (!finished && turn.turn.status && turn.turn.status !== "inProgress") {
      complete(turn.turn.status, turn.turn)
    }
    if (!finished) {
      const completed = completionByTurn.get(`${threadId}\0${turnId}`)
      if (completed) {
        completionByTurn.delete(`${threadId}\0${turnId}`)
        complete(completed.status ?? "failed", completed)
      }
    }
    return await raceCancellation(completion)
  } catch (error) {
    const failure =
      error instanceof CardChatError
        ? error
        : new CardChatError("transport", "Card chat could not complete", error)
    if (!finished && !cancelReason) {
      cancelReason = failure
      emitEvent({ type: "error", error: failure })
    } else if (cancelReason && !finished) {
      emitEvent({ type: "error", error: cancelReason })
    }
    throw failure
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener("abort", onAbort)
    unsubscribe?.()
    const activeClient = client
    if (activeClient && cancelReason && threadId && turnId) {
      await Promise.race([
        activeClient.interruptTurn(threadId, turnId).catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
      ])
    }
    if (activeClient) await activeClient.close().catch(() => undefined)
    if (lateClient && !client) {
      lateClient
        .then((candidate) => candidate.close().catch(() => undefined))
        .catch(() => undefined)
    }
  }
}
