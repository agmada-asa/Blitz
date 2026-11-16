/**
 * Decides what a continued turn asks for when the reply it continues stopped
 * (paused, or cut off by a usage limit). Shared by the chat mutation and its
 * tests; it has no server-only imports.
 */

/** One stored chat message, as far as resuming a stopped reply needs it. */
export interface StoppedTurnMessage {
  /** Who wrote the message. */
  readonly role: "user" | "assistant"
  /** The message text saved so far. */
  readonly content: string
}

/**
 * Returns the request to send again when a stopped reply has no text yet.
 *
 * "Continue from where it stopped" only makes sense when part of a reply
 * arrived. A reply that stopped before its first word has nothing to continue:
 * told to continue anyway, the model reads the last finished reply, says
 * nothing was cut off, and never answers the request. Sending the request
 * again lets the turn run as it would have, including Teach turning `Next
 * section` into the section an update decided.
 *
 * @param messages - The chat's newest messages, newest first; the first is
 *   the stopped reply.
 * @returns The request the stopped reply was answering, or undefined when the
 *   reply already has text to continue or no user request with text precedes it.
 */
export function stoppedRequestToResend(
  messages: readonly StoppedTurnMessage[]
): string | undefined {
  const [stopped, request] = messages
  if (!stopped || stopped.role !== "assistant" || stopped.content.trim())
    return undefined
  if (request?.role !== "user" || !request.content.trim()) return undefined
  return request.content
}
