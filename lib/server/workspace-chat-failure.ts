/** Maps workspace chat errors to safe recovery copy for the stream and saved transcript. */

import { SavedModelSettingsError } from "./ai-model-settings.ts"
import { CardChatError } from "./card-chat.ts"

/** Returns recovery copy and a stable diagnostic reason for one failed turn. */
export function workspaceChatFailure(
  error: unknown,
  contextSaved: boolean
): {
  reason: string
  message: string
} {
  if (error instanceof SavedModelSettingsError)
    return { reason: "invalid-input", message: error.message }
  if (error instanceof CardChatError && error.reason === "invalid-input")
    return { reason: error.reason, message: error.message }
  if (
    error instanceof CardChatError &&
    (error.reason === "provider-overloaded" ||
      error.reason === "usage-limit" ||
      error.reason === "rate-limit")
  )
    return {
      reason: error.reason,
      message: `${error.message}${contextSaved ? " Your chat context is saved." : ""}`,
    }
  // Reached only when compacting could not free room, or was not possible.
  if (error instanceof CardChatError && error.reason === "context-window")
    return {
      reason: error.reason,
      message: `${error.message} Compacting it didn't free enough room. Start a new chat, or start the unit over in Teach, to carry on.`,
    }
  const recovery = contextSaved
    ? "Your chat context is saved, so try again."
    : "Try again."
  if (error instanceof CardChatError && error.reason === "timeout")
    return {
      reason: error.reason,
      message: `That reply took too long. ${recovery}`,
    }
  if (error instanceof CardChatError && error.reason === "aborted")
    return {
      reason: error.reason,
      message: `That reply was interrupted. ${recovery}`,
    }
  return {
    reason: error instanceof CardChatError ? error.reason : "unknown",
    message: `Blitz could not finish that reply. ${recovery}`,
  }
}

/** Longest diagnostic stored with a failed chat. */
const MAX_FAILURE_DETAIL_LENGTH = 500

/**
 * Describes the underlying cause of a failed turn for diagnosis.
 *
 * Joins the error's message with its cause's message, because provider
 * failures are wrapped: a failed Codex turn reads "Blitz turn failed" while
 * the cause carries the runtime's reason, such as model capacity.
 *
 * @param error - Value thrown by the turn.
 * @returns A bounded single-line description, or undefined when the value
 *   carries no message.
 */
export function workspaceChatFailureDetail(error: unknown): string | undefined {
  const messages: string[] = []
  let current: unknown = error
  // Two levels cover Blitz's wrapper and the provider's own error.
  for (let depth = 0; depth < 2 && current; depth += 1) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object" &&
            current !== null &&
            "message" in current &&
            typeof current.message === "string"
          ? current.message
          : undefined
    if (message?.trim() && !messages.includes(message.trim()))
      messages.push(message.trim())
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined
  }
  const detail = messages.join(": ").replace(/\s+/g, " ")
  return detail ? detail.slice(0, MAX_FAILURE_DETAIL_LENGTH) : undefined
}
