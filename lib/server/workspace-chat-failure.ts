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
