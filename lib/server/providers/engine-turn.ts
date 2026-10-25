/**
 * Runs one bounded Codex or Claude Code turn through agent-engines and reports
 * it in Blitz's card-chat event and result shapes.
 *
 * The library owns the runtime mechanics: starting or resuming the thread,
 * streaming, approvals, interrupts, and process lifetime. This adapter owns
 * Blitz's turn policy around it: the wall-clock deadline, caller cancellation,
 * output bounds, which text counts as the reply and which as thought, how
 * failures map to recovery copy, and that the engine is closed on every exit.
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
import { formatUsd } from "../../spending-limits.ts"
import type { EngineProviderId } from "./engines.ts"

/** How long cleanup waits for an interrupt or engine shutdown before moving on. */
const CLEANUP_TIMEOUT_MS = 1_000

/**
 * Plan reviews one Codex turn may go through: a first plan and revisions
 * after the learner sends it back with a note.
 */
const MAX_PLAN_ROUNDS = 4

/** What Codex is told once the learner approves its plan. */
const PLAN_APPROVED_PROMPT =
  "The learner approved the plan. Carry it out now, exactly as proposed."

/** One turn to run on a freshly created engine, which this adapter closes. */
export interface EngineTurnRequest {
  /** Blitz provider the engine belongs to; decides which text is the reply. */
  readonly providerId: EngineProviderId
  /** Engine created for this turn alone. It is closed when the turn ends. */
  readonly engine: Engine
  /** Thread settings, applied on start and again on resume. */
  readonly thread: ThreadOptions
  /** Saved thread to resume; omitted starts a new one. */
  readonly threadId?: string
  /** Prompt text and native images. */
  readonly input: TurnInput
  /** Per-turn model and effort, when they differ from the thread's. */
  readonly turnOptions?: TurnOptions
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline for the whole turn, thread start included. */
  readonly timeoutMs?: number
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
  let text = ""
  let thought = ""
  const answers: string[] = []
  const thoughts: string[] = []
  // The latest plan proposed in plan mode, and whether it still awaits review.
  let lastPlan: string | undefined
  let pendingPlan: string | undefined
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

  /** Reports the thread and turn IDs once, as soon as either source knows them. */
  const started = (id: string): void => {
    if (turnId || !thread || !id) return
    turnId = id
    emit({ type: "turn-started", threadId: thread.id, turnId: id })
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
      case "plan.proposal.done":
        if (event.text.trim()) lastPlan = pendingPlan = event.text.trim()
        return
    }
  }

  /** Runs one turn on the open thread and waits for it and its events. */
  const runOnce = async (
    input: TurnInput,
    turnOptions?: TurnOptions
  ): Promise<TurnResult> => {
    const running = thread!.run(input, turnOptions)
    turn = running
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
        request.threadId
          ? request.engine.resumeThread(request.threadId, request.thread)
          : request.engine.startThread(request.thread)
      )
    } catch (error) {
      throw cancelReason ?? startFailure(error)
    }
    let result = await runOnce(request.input, request.turnOptions)
    if (request.providerId === "codex" && request.turnOptions?.mode === "plan")
      result = await followPlans(result)
    if (cancelReason) throw cancelReason
    return complete(result)
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
  function complete(result: TurnResult): CardChatResult {
    if (result.status === "failed")
      throw turnFailure(result.error, request.thread.limits)
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
      turnId: turnId ?? result.turnId,
      text: reply,
      ...(finalThought ? { thought: finalThought } : {}),
      durationMs: Math.max(0, Date.now() - startedAt),
      ...(result.output === undefined ? {} : { output: result.output }),
    }
    finished = true
    emit({ ...value, type: "completed", status: "completed" })
    return value
  }
}
