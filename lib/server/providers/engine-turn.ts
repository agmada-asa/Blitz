/**
 * Runs one bounded Codex, Claude Code or OpenCode turn through agent-engines
 * and reports it in Blitz's card-chat event and result shapes.
 *
 * The library owns the runtime mechanics: starting or resuming the thread,
 * streaming, approvals, interrupts, and process lifetime. This adapter owns
 * Blitz's turn policy around it: the wall-clock deadline, caller cancellation,
 * output bounds, which text counts as the reply and which as thought, how
 * failures map to recovery copy, and that the engine is closed on every exit.
 *
 * Around the turn itself it can also fork the thread from a saved one (a
 * branched or edited chat), compact the context before the turn, rewind the
 * latest turn so a reply is redone in place, and read how full the context is
 * once the turn ends. Refusals, denied tools, and safety checks are forwarded
 * as notices; every other runtime notice is logged on the server only.
 */

import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import {
  RuntimeAuthError,
  RuntimeCompatibilityError,
  RuntimeModelSubstitutionError,
  RuntimeModelUnavailableError,
  type AgentEvent,
  type AgentRequest,
  type ApprovalRequest,
  type Engine,
  type Thread,
  type ThreadOptions,
  type Turn,
  type TurnError,
  type TurnInput,
  type TurnLimits,
  type TurnOptions,
  type TurnResult,
} from "agent-engines"

import {
  CardChatError,
  DEFAULT_CARD_CHAT_TIMEOUT_MS,
  MAX_CARD_CHAT_STREAM_TEXT_LENGTH,
  type CardChatEvent,
  type CardChatResult,
} from "../card-chat.ts"
import { PLAN_STOPPED_MESSAGE, refuseAgentRequest } from "../agent-request.ts"
import {
  normalizeContextUsage,
  type TurnContextUsage,
} from "../../context-usage.ts"
import { formatUsd } from "../../spending-limits.ts"
import { shownTurnNotice } from "../../turn-notices.ts"
import type { EngineProviderId } from "./engines.ts"

/** How long cleanup waits for an interrupt or engine shutdown before moving on. */
const CLEANUP_TIMEOUT_MS = 1_000

/** How long reading context usage may take before the turn completes without it. */
const CONTEXT_USAGE_TIMEOUT_MS = 2_000

/** Longest runtime notice text written to the server log. */
const MAX_LOGGED_NOTICE_LENGTH = 300

/**
 * Plan reviews one Codex turn may go through: a first plan and revisions
 * after the learner sends it back with a note.
 */
const MAX_PLAN_ROUNDS = 4

/** What Codex is told once the learner approves its plan. */
const PLAN_APPROVED_PROMPT =
  "The learner approved the plan. Carry it out now, exactly as proposed."

/** Blitz providers whose turns run on an agent-engines engine. */
export type TurnProviderId = EngineProviderId | "opencode"

/** Events that are the runtime's own output for a turn, confirming a resumed session. */
const CONFIRMING_EVENTS: ReadonlySet<AgentEvent["type"]> = new Set([
  "text.delta",
  "text.done",
  "reasoning.delta",
  "reasoning.done",
  "tool.started",
  "tool.progress",
  "tool.completed",
  "file.changed",
  "request",
])

/** One turn to run on a freshly created engine, which this adapter closes. */
export interface EngineTurnRequest {
  /** Blitz provider the engine belongs to; decides which text is the reply. */
  readonly providerId: TurnProviderId
  /** Engine created for this turn alone. It is closed when the turn ends. */
  readonly engine: Engine
  /** Thread settings, applied on start and again on resume. */
  readonly thread: ThreadOptions
  /** Saved thread to resume; omitted starts a new one. */
  readonly threadId?: string
  /**
   * Saved thread to copy instead of starting or resuming one: the new thread
   * carries the original's conversation through `throughTurnId` (inclusive),
   * or all of it. Takes precedence over `threadId`. A failed copy throws a
   * `transport` error before the turn is accepted, so callers can fall back.
   */
  readonly fork?: { readonly threadId: string; readonly throughTurnId?: string }
  /**
   * Compacts the thread before the turn runs. A compaction that fails is
   * logged and the turn runs anyway, since the runtime may still have room.
   */
  readonly compactFirst?: boolean
  /**
   * Input sent instead of `input` when `compactFirst` compacted the thread,
   * such as a prompt that restates what the compaction summarised away.
   */
  readonly compactedInput?: TurnInput
  /**
   * Drops this turn and every later one before the new turn runs, so the reply
   * is redone in place. Reported with a `rewound` event; a rewind that fails is
   * logged and the turn runs on top of the existing conversation instead.
   */
  readonly rewindBeforeTurnId?: string
  /** Reads how full the context window is after a completed turn. */
  readonly readContextUsage?: boolean
  /** Prompt text and native images. */
  readonly input: TurnInput
  /** Per-turn model and effort, when they differ from the thread's. */
  readonly turnOptions?: TurnOptions
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline for the whole turn, thread start included. */
  readonly timeoutMs?: number
  /**
   * Holds back `turn-started` on a resumed thread until the runtime sends
   * something for the turn. ACP agents report a turn as started before they
   * have checked the reloaded session, so a resume they reject would otherwise
   * look like an accepted turn. A resumed turn that fails before any output
   * becomes a `transport` failure with no `turn-started`, which is how the
   * chat knows to replay its history into a new session.
   */
  readonly confirmResume?: boolean
}

/** Callbacks for one engine turn. */
export interface EngineTurnOptions {
  /** Receives turn, text, thought, activity, completion, and error events in order. */
  readonly onEvent?: (event: CardChatEvent) => void
  /**
   * Answers one approval, question, or elicitation by calling its `respond`.
   * Omitted, every request is refused. A handler that throws refuses it too.
   */
  readonly onRequest?: (request: AgentRequest) => Promise<void>
}

/** Returns the text of a turn input, for validation. */
function inputText(input: TurnInput): string {
  return typeof input === "string" ? input : input.text
}

/**
 * Maps a failed turn's classified error to the app's recovery reasons and copy.
 * @param error Classified failure from the runtime.
 * @param limits The thread's own caps, so a `limit` failure can name the one it hit.
 */
export function turnFailure(
  error: TurnError | undefined,
  limits?: TurnLimits
): CardChatError {
  switch (error?.kind) {
    case "limit": {
      // Claude Code reports which cap ended the turn; budget is the usual one.
      const steps = /turn/i.test(error.message) && !/budget/i.test(error.message)
      const which =
        steps && limits?.maxTurns
          ? `Stopped after ${limits.maxTurns} steps, your limit for one task.`
          : limits?.maxBudgetUsd
            ? `Stopped at your ${formatUsd(limits.maxBudgetUsd)} limit for one task.`
            : "Stopped at your spending limit for one task."
      return new CardChatError(
        "spend-limit",
        `${which} Nothing was saved. Raise the limit in Settings, or try again with less material.`,
        error
      )
    }
    case "usage-limit":
      return new CardChatError(
        "usage-limit",
        "You've reached the selected provider's usage limit. Wait for it to reset or choose another provider in Settings.",
        error
      )
    case "rate-limit":
      // Codex reports a model at capacity as a rate limit with its own message.
      return /overload|capacity/i.test(error.message)
        ? new CardChatError(
            "provider-overloaded",
            "The selected model is at capacity. Try again shortly or choose another model in Settings.",
            error
          )
        : new CardChatError(
            "rate-limit",
            "Too many requests to the selected provider. Wait a moment, then try again.",
            error
          )
    case "model":
      return new CardChatError(
        "invalid-input",
        "The selected model is not available. Choose another model in Settings.",
        error
      )
    case "connection":
      return new CardChatError(
        "transport",
        "The provider stopped before finishing this turn",
        error
      )
    case "context-window":
      return new CardChatError(
        "context-window",
        "This conversation ran out of room for the reply.",
        error
      )
    case "auth":
      return new CardChatError(
        "transport",
        "The selected provider is signed out. Connect it in Settings.",
        error
      )
    default:
      return new CardChatError("turn-failed", "Blitz turn failed", error)
  }
}

/** Maps an error thrown while starting a thread to Blitz's recovery reasons. */
function startFailure(error: unknown): CardChatError {
  if (error instanceof CardChatError) return error
  if (
    error instanceof RuntimeModelUnavailableError ||
    error instanceof RuntimeModelSubstitutionError
  )
    return new CardChatError(
      "invalid-input",
      error instanceof RuntimeModelUnavailableError
        ? error.message
        : "The provider would answer with a different model than the one selected. Choose another model in Settings.",
      error
    )
  if (error instanceof RuntimeAuthError)
    return new CardChatError(
      "transport",
      "The selected provider is not signed in. Connect it in Settings.",
      error
    )
  if (error instanceof RuntimeCompatibilityError)
    return new CardChatError(
      "transport",
      "The selected provider needs an update before Blitz can use it.",
      error
    )
  return new CardChatError(
    "transport",
    "The selected provider could not start this turn",
    error
  )
}

/** Writes a runtime notice Blitz does not show to the server log, bounded. */
function logNotice(kind: string, message: string): void {
  console.info("Provider notice", {
    kind,
    message: message.replace(/\s+/g, " ").slice(0, MAX_LOGGED_NOTICE_LENGTH),
  })
}

/** Reads a thread's context usage within a short bound; undefined when unknown. */
async function readContextUsage(
  thread: Thread
): Promise<TurnContextUsage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const usage = await Promise.race([
      thread.contextUsage(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CONTEXT_USAGE_TIMEOUT_MS)
      }),
    ])
    return usage ? normalizeContextUsage(usage) : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves after a bounded wait, so cleanup never hangs on a stuck runtime. */
function bounded(operation: Promise<unknown>): Promise<void> {
  return Promise.race([
    operation.then(
      () => undefined,
      () => undefined
    ),
    new Promise<void>((resolve) => setTimeout(resolve, CLEANUP_TIMEOUT_MS)),
  ])
}

/**
 * Runs one turn and returns its reply.
 *
 * Text from Codex progress notes and reasoning becomes thought; the reply is
 * Codex's answer messages, or everything Claude streamed. Subagent text stays
 * out of both; subagent tool activity is still reported.
 *
 * @throws CardChatError for invalid input, cancellation, the deadline, a
 *   failed or interrupted turn, a reply over the size bound, or an empty reply.
 */
export async function runEngineTurn(
  request: EngineTurnRequest,
  options: EngineTurnOptions = {}
): Promise<CardChatResult> {
  const { engine } = request
  try {
    if (!request.thread.cwd || !isAbsolute(request.thread.cwd))
      throw new CardChatError(
        "invalid-input",
        "Provider workspace must be an absolute path"
      )
    if (request.threadId !== undefined && !request.threadId.trim())
      throw new CardChatError("invalid-input", "threadId must not be empty")
    if (!inputText(request.input).trim())
      throw new CardChatError(
        "invalid-input",
        "Blitz text turn prompt must not be empty"
      )
    const timeoutMs = request.timeoutMs ?? DEFAULT_CARD_CHAT_TIMEOUT_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new CardChatError(
        "invalid-input",
        "Provider timeout must be a positive integer"
      )
    return await runTurn(request, options, timeoutMs)
  } finally {
    await bounded(engine.close())
  }
}

/** Runs a validated turn; the caller closes the engine afterwards. */
async function runTurn(
  request: EngineTurnRequest,
  options: EngineTurnOptions,
  timeoutMs: number
): Promise<CardChatResult> {
  const startedAt = Date.now()
  let thread: Thread | undefined
  let turn: Turn | undefined
  let turnId: string | undefined
  /** A turn ID held back until the runtime confirms a resumed session. */
  let pendingTurnId: string | undefined
  const awaitingConfirmation = Boolean(
    request.confirmResume && request.threadId
  )
  let confirmed = !awaitingConfirmation
  let text = ""
  let thought = ""
  const answers: string[] = []
  const thoughts: string[] = []
  // The latest plan proposed in plan mode, and whether it still awaits review.
  let lastPlan: string | undefined
  let pendingPlan: string | undefined
  // Runtime turns this reply took: more than one after a reviewed Codex plan.
  let rounds = 0
  let finished = false
  let cancelReason: CardChatError | undefined
  let rejectCancellation: ((error: CardChatError) => void) | undefined
  const cancellation = new Promise<never>((_, reject) => {
    rejectCancellation = reject
  })
  void cancellation.catch(() => undefined)

  /** Delivers one event, isolating consumer failures from the turn. */
  const emit = (event: CardChatEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      // Event consumers cannot corrupt cleanup or completion state.
    }
  }

  /** Fails the turn once and wakes every pending race. */
  const cancel = (error: CardChatError): void => {
    if (finished || cancelReason) return
    cancelReason = error
    rejectCancellation?.(error)
  }

  /** Races one runtime operation against cancellation. */
  const race = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, cancellation])

  /**
   * Reports the thread and turn IDs once, as soon as either source knows them,
   * or holds them until {@link confirm} when the resume is unconfirmed.
   */
  const started = (id: string): void => {
    if (turnId || !thread || !id) return
    if (!confirmed) {
      pendingTurnId ??= id
      return
    }
    turnId = id
    emit({ type: "turn-started", threadId: thread.id, turnId: id })
  }

  /** Marks a resumed session as working and reports any held-back start. */
  const confirm = (): void => {
    if (confirmed) return
    confirmed = true
    if (pendingTurnId) started(pendingTurnId)
  }

  /** Appends streamed reply or thought text within the output bound. */
  const stream = (delta: string, isThought: boolean): void => {
    if (!thread || !delta) return
    const id = turnId ?? ""
    if (isThought) {
      if (thought.length + delta.length > MAX_CARD_CHAT_STREAM_TEXT_LENGTH)
        return
      thought += delta
      emit({ type: "thought-delta", threadId: thread.id, turnId: id, delta })
      return
    }
    if (text.length + delta.length > MAX_CARD_CHAT_STREAM_TEXT_LENGTH) {
      cancel(
        new CardChatError(
          "transport",
          "Blitz assistant output exceeded the configured limit"
        )
      )
      return
    }
    text += delta
    emit({ type: "text-delta", threadId: thread.id, turnId: id, delta })
  }

  /** Routes one engine event into Blitz's event shapes. */
  const handle = (event: AgentEvent): void => {
    // Output for the turn shows the resumed session works; housekeeping
    // updates an agent sends after a reload (its command list) do not.
    if (CONFIRMING_EVENTS.has(event.type)) confirm()
    if (event.type === "notice") {
      // A subagent's denied tool still explains a short reply, so it is kept.
      const notice = shownTurnNotice(event.kind, event.message, event.details)
      if (notice) emit({ type: "notice", notice })
      else logNotice(event.kind, event.message)
      return
    }
    if (event.type === "request") {
      const answer = options.onRequest
        ? options.onRequest(event.request)
        : refuseAgentRequest(event.request)
      void answer.catch(() => refuseAgentRequest(event.request))
      return
    }
    if (
      event.type === "tool.started" ||
      event.type === "tool.progress" ||
      event.type === "tool.completed" ||
      event.type === "file.changed"
    ) {
      emit({
        type: "activity",
        notification: {
          method:
            event.type === "file.changed"
              ? "file/changed"
              : `tool/${event.type.slice(5)}`,
          params: event,
        },
      })
      return
    }
    // Subagent text and thinking are theirs, not this turn's reply or thought.
    if (event.agentId) return
    switch (event.type) {
      case "turn.started":
        started(event.turnId)
        return
      case "text.delta":
        stream(event.delta, event.phase === "commentary")
        return
      case "reasoning.delta":
        stream(event.delta, true)
        return
      case "text.done":
        if (!event.text.trim()) return
        if (event.phase === "commentary") thoughts.push(event.text.trim())
        else answers.push(event.text)
        return
      case "reasoning.done":
        if (event.text.trim()) thoughts.push(event.text.trim())
        return
      case "compacted":
        // The runtime compacted by itself mid-turn.
        emit({
          type: "compacted",
          origin: "runtime",
          ...(event.beforeTokens !== undefined
            ? { beforeTokens: event.beforeTokens }
            : {}),
          ...(event.afterTokens !== undefined
            ? { afterTokens: event.afterTokens }
            : {}),
        })
        return
      case "plan.proposal.done":
        if (event.text.trim()) lastPlan = pendingPlan = event.text.trim()
        return
    }
  }

  /**
   * Compacts the opened thread as a turn of its own. Its events stay out of
   * the reply: only the compaction itself is reported. A failed or refused
   * compaction is logged and left for the runtime's own handling.
   */
  const compact = async (opened: Thread): Promise<boolean> => {
    let compacted = false
    try {
      const compaction = opened.compact()
      turn = compaction
      const consumed = (async () => {
        for await (const event of compaction) {
          if (event.type !== "compacted" || event.agentId || compacted) continue
          compacted = true
          emit({
            type: "compacted",
            origin: "requested",
            ...(event.beforeTokens !== undefined
              ? { beforeTokens: event.beforeTokens }
              : {}),
            ...(event.afterTokens !== undefined
              ? { afterTokens: event.afterTokens }
              : {}),
          })
        }
      })()
      const result = await race(compaction.result)
      await race(consumed)
      if (result.status === "completed" && !compacted) {
        compacted = true
        emit({ type: "compacted", origin: "requested" })
      }
      if (result.status !== "completed")
        console.warn("Provider could not compact the thread", {
          status: result.status,
          kind: result.error?.kind ?? "unknown",
        })
      turn = undefined
      return result.status === "completed"
    } catch (error) {
      // A cancelled compaction stays the active turn, so cleanup interrupts it.
      if (cancelReason) throw cancelReason
      turn = undefined
      console.warn("Provider could not compact the thread", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
      return false
    }
  }

  /** Rewinds the opened thread before `turnId`, reporting how many turns went. */
  const rewind = async (opened: Thread, turnId: string): Promise<void> => {
    try {
      const result = await race(opened.rewind(turnId))
      emit({ type: "rewound", droppedTurns: result.droppedTurns })
    } catch (error) {
      if (cancelReason) throw cancelReason
      console.warn("Provider could not rewind the thread", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
    }
  }

  /** Runs one turn on the open thread and waits for it and its events. */
  const runOnce = async (
    input: TurnInput,
    turnOptions?: TurnOptions
  ): Promise<TurnResult> => {
    const running = thread!.run(input, turnOptions)
    turn = running
    rounds += 1
    void running.id.then(started, () => undefined)
    const consumed = (async () => {
      for await (const event of running) handle(event)
    })()
    const result: TurnResult = await race(running.result)
    await race(consumed)
    return result
  }

  /**
   * Shows a Codex plan for review the way Claude Code asks for one: as a
   * `plan` approval through `onRequest`, so both providers use one card.
   * Resolves with the learner's decision; a failed or missing handler declines.
   */
  const reviewPlan = (
    plan: string
  ): Promise<{ decision: string; message?: string }> =>
    new Promise((resolve) => {
      const review: ApprovalRequest = {
        kind: "approval",
        id: `plan-${randomUUID()}`,
        action: "plan",
        plan,
        title: "Approve the plan",
        raw: { plan },
        respond: async (decision) => resolve(decision),
      }
      const answer = options.onRequest
        ? options.onRequest(review)
        : refuseAgentRequest(review)
      void answer.catch(() => resolve({ decision: "deny" }))
    })

  /**
   * Codex ends a plan-mode turn with its proposal instead of asking. Each
   * proposal goes to review: approval runs the plan as a new turn in default
   * mode, a note runs another planning turn with it, and a plain decline ends
   * here with the plan as the reply.
   */
  const followPlans = async (first: TurnResult): Promise<TurnResult> => {
    let current = first
    for (let round = 0; round < MAX_PLAN_ROUNDS; round += 1) {
      const plan = pendingPlan
      if (current.status !== "completed" || !plan) return current
      pendingPlan = undefined
      const decision = await race(reviewPlan(plan))
      if (decision.decision === "allow" || decision.decision === "allow-session") {
        lastPlan = undefined
        return runOnce(PLAN_APPROVED_PROMPT, { mode: "default" })
      }
      if (!decision.message?.trim() || decision.message === PLAN_STOPPED_MESSAGE)
        return current
      current = await runOnce(decision.message, { mode: "plan" })
    }
    return current
  }

  const timer = setTimeout(
    () =>
      cancel(
        new CardChatError(
          "timeout",
          `Provider turn timed out after ${timeoutMs}ms`
        )
      ),
    timeoutMs
  )
  const onAbort = (): void =>
    cancel(new CardChatError("aborted", "Provider turn was interrupted"))
  if (request.signal?.aborted) onAbort()
  else request.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (cancelReason) throw cancelReason
    try {
      thread = await race(
        request.fork
          ? request.engine.forkThread(request.fork.threadId, {
              ...request.thread,
              ...(request.fork.throughTurnId
                ? { throughTurnId: request.fork.throughTurnId }
                : {}),
            })
          : request.threadId
            ? request.engine.resumeThread(request.threadId, request.thread)
            : request.engine.startThread(request.thread)
      )
    } catch (error) {
      throw (
        cancelReason ??
        (request.fork
          ? new CardChatError(
              "transport",
              "The saved conversation could not be copied",
              error
            )
          : startFailure(error))
      )
    }
    // Rewind first: rewinding to before a compaction would undo it.
    if (request.rewindBeforeTurnId)
      await rewind(thread, request.rewindBeforeTurnId)
    const compacted = request.compactFirst ? await compact(thread) : false
    let result = await runOnce(
      compacted && request.compactedInput ? request.compactedInput : request.input,
      request.turnOptions
    )
    if (request.providerId === "codex" && request.turnOptions?.mode === "plan")
      result = await followPlans(result)
    if (cancelReason) throw cancelReason
    const contextUsage =
      request.readContextUsage && result.status === "completed"
        ? await readContextUsage(thread)
        : undefined
    return complete(result, contextUsage)
  } catch (error) {
    const failure =
      cancelReason ??
      (error instanceof CardChatError
        ? error
        : new CardChatError(
            "transport",
            "Provider turn could not complete",
            error
          ))
    finished = true
    emit({ type: "error", error: failure })
    throw failure
  } finally {
    finished = true
    clearTimeout(timer)
    request.signal?.removeEventListener("abort", onAbort)
    if (cancelReason && turn) await bounded(turn.interrupt())
    if (thread) await bounded(thread.close())
  }

  /** Builds the result of a settled turn, or throws its mapped failure. */
  function complete(
    result: TurnResult,
    contextUsage: TurnContextUsage | undefined
  ): CardChatResult {
    if (result.status === "failed") {
      if (!confirmed)
        throw new CardChatError(
          "transport",
          "The provider could not resume this session",
          result.error
        )
      throw turnFailure(result.error, request.thread.limits)
    }
    confirm()
    if (result.status === "interrupted")
      throw new CardChatError("turn-interrupted", "Blitz turn interrupted")
    // A schema-checked reply may arrive only as parsed output (Claude Code
    // returns it through a tool call), so its JSON stands in as the text.
    const reply =
      (request.providerId === "codex"
        ? answers.join("\n") || text || result.text
        : text || result.text) ||
      (result.output === undefined ? "" : JSON.stringify(result.output)) ||
      // A plan that was not approved is the whole reply.
      (lastPlan ?? "")
    if (reply.length > MAX_CARD_CHAT_STREAM_TEXT_LENGTH)
      throw new CardChatError(
        "transport",
        "Blitz assistant output exceeded the configured limit"
      )
    if (!reply.trim())
      throw new CardChatError(
        "turn-failed",
        "Blitz completed without assistant text"
      )
    const finalThought = thoughts.join("\n\n") || thought.trim() || undefined
    const value: CardChatResult = {
      threadId: thread!.id,
      // A reply that carried out an approved plan ends on the runtime turn
      // that did the work, so a branch forked through it keeps that work.
      turnId: (rounds > 1 ? result.turnId : turnId) || result.turnId,
      text: reply,
      ...(finalThought ? { thought: finalThought } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(contextUsage ? { contextUsage } : {}),
      ...(result.output === undefined ? {} : { output: result.output }),
    }
    finished = true
    emit({ ...value, type: "completed", status: "completed" })
    return value
  }
}

/** A compaction of a saved thread, outside any turn (Compact now). */
export interface EngineCompactionRequest {
  /** Engine created for this compaction alone. It is closed when it ends. */
  readonly engine: Engine
  /** Thread settings, as the thread's turns use them. */
  readonly thread: ThreadOptions
  /** Saved thread to compact. */
  readonly threadId: string
  /** Wall-clock deadline for resuming and compacting. */
  readonly timeoutMs: number
}

/** How a compaction outside a turn went. */
export interface EngineCompactionResult {
  /** Whether the runtime compacted the thread. */
  readonly compacted: boolean
  /** How full the context is afterwards, when the runtime says. */
  readonly contextUsage?: TurnContextUsage
}

/**
 * Resumes a saved thread, compacts it, and reads its context usage, then
 * closes the thread and engine. Never throws: a thread that cannot be resumed
 * or compacted reports `compacted: false`, and a stuck runtime is abandoned
 * at the deadline.
 */
export async function runEngineCompaction(
  request: EngineCompactionRequest
): Promise<EngineCompactionResult> {
  let thread: Thread | undefined
  let compaction: Turn | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), request.timeoutMs)
  })
  try {
    const opened = await Promise.race([
      request.engine.resumeThread(request.threadId, request.thread),
      deadline,
    ])
    if (opened === "timeout") return { compacted: false }
    thread = opened
    compaction = opened.compact()
    const running = compaction
    // Drain events so the turn can settle; only its result matters here.
    const drained = (async () => {
      for await (const event of running) void event
    })()
    const result = await Promise.race([running.result, deadline])
    if (result === "timeout") return { compacted: false }
    await Promise.race([drained, deadline])
    if (result.status !== "completed") {
      console.warn("Provider could not compact the thread", {
        status: result.status,
        kind: result.error?.kind ?? "unknown",
      })
      return { compacted: false }
    }
    compaction = undefined
    const contextUsage = await readContextUsage(opened)
    return { compacted: true, ...(contextUsage ? { contextUsage } : {}) }
  } catch (error) {
    console.warn("Provider could not compact the thread", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return { compacted: false }
  } finally {
    clearTimeout(timer)
    if (compaction) await bounded(compaction.interrupt())
    if (thread) await bounded(thread.close())
    await bounded(request.engine.close())
  }
}
