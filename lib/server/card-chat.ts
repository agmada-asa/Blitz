/**
 * Defines the event, result, and error types every provider adapter shares.
 *
 * Codex and Claude Code turns run through agent-engines (see
 * `providers/engine-turn.ts`) and OpenCode through Blitz's ACP adapter; both
 * report in these shapes. The names keep their original card chat prefix;
 * workspace chat, Teach, research, and project agents all use them.
 */

import type { TurnContextUsage } from "../context-usage.ts"
import type { TurnNotice } from "../turn-notices.ts"

export type { TurnContextUsage } from "../context-usage.ts"
export type { TurnNotice } from "../turn-notices.ts"

/** Maximum assistant text plus raced delta text retained for one turn. */
export const MAX_CARD_CHAT_STREAM_TEXT_LENGTH = 250_000
/** Default wall-clock limit for one text turn. */
export const DEFAULT_CARD_CHAT_TIMEOUT_MS = 60_000

/** One provider activity frame: a tool, file, or research step, by method name. */
export interface CardChatActivity {
  /** Activity family, such as `tool/started` or `session/update`. */
  readonly method: string
  /** Untrusted activity details, read only through bounded normalizers. */
  readonly params?: unknown
}

/** One native request surfaced for diagnostics (ACP permission prompts). */
export interface CardChatServerRequest {
  /** Native request identifier. */
  readonly id: string | number
  /** Native request method. */
  readonly method: string
  /** Untrusted native request parameters. */
  readonly params?: unknown
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

/** Typed lifecycle event emitted once the runtime accepts a turn. */
export interface CardChatTurnStartedEvent {
  /** Discriminator for early persistence of the conversation identifiers. */
  readonly type: "turn-started"
  /** Server-issued thread identifier. */
  readonly threadId: string
  /** Server-issued turn identifier. */
  readonly turnId: string
}

/** Typed activity event carrying one tool or progress frame. */
export interface CardChatActivityEvent {
  /** Discriminator for non-text streamed activity. */
  readonly type: "activity"
  /** Activity frame, normalized by `lib/provider-activity.ts`. */
  readonly notification: CardChatActivity
}

/** Typed activity event for server requests such as approval prompts. */
export interface CardChatServerRequestEvent {
  /** Discriminator for surfaced server requests. */
  readonly type: "activity"
  /** Native server request, kept for diagnostics. */
  readonly serverRequest: CardChatServerRequest
}

/** A notice the learner should see: a refusal, a denied tool, or a safety check. */
export interface CardChatNoticeEvent {
  /** Discriminator for user-facing runtime notices. */
  readonly type: "notice"
  /** Notice already filtered to the kinds Blitz shows. */
  readonly notice: TurnNotice
}

/** The runtime compacted the thread's context, on Blitz's request or by itself. */
export interface CardChatCompactedEvent {
  /** Discriminator for context compaction. */
  readonly type: "compacted"
  /** `requested` when Blitz asked before the turn; `runtime` when the runtime did it mid-turn. */
  readonly origin: "requested" | "runtime"
  /** Tokens in the context before compaction, when the runtime said. */
  readonly beforeTokens?: number
  /** Tokens in the context after compaction, when the runtime said. */
  readonly afterTokens?: number
}

/** The thread was rewound before the turn ran, dropping the replaced turns. */
export interface CardChatRewoundEvent {
  /** Discriminator for a successful rewind. */
  readonly type: "rewound"
  /** Turns the runtime dropped from the conversation. */
  readonly droppedTurns: number
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
  | "context-window"

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
  | CardChatNoticeEvent
  | CardChatCompactedEvent
  | CardChatRewoundEvent

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
  /** How full the thread's context window was when the turn ended, when asked for and known. */
  readonly contextUsage?: TurnContextUsage
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
