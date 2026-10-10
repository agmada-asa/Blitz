/**
 * Sends one Teach turn through the shared chat route.
 *
 * The Teach screen renders replies from Convex, which the route updates
 * several times a second, so this helper only drives the request and reports
 * whether the turn finished or why it failed.
 */

import { readChatStream } from "../chat-stream.ts"

/** Outcome of one Teach turn request. */
export type TeachTurnResult =
  | { ok: true }
  | { ok: false; error: string; paused?: boolean }

/** Creates a unique message identity so retries never send a turn twice. */
export function createClientMessageId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Posts a learner message, or continues a paused reply, and waits for the
 * stream to end.
 *
 * @param input.chatId The unit's Teach session.
 * @param input.message Learner text or a quick reply; ignored when continuing.
 * @param input.continuationOf Paused assistant message to resume in place.
 * @param input.signal Aborts the browser request; the server keeps the saved partial reply.
 */
export async function sendTeachTurn(input: {
  chatId: string
  message: string
  continuationOf?: string
  signal?: AbortSignal
}): Promise<TeachTurnResult> {
  let response: Response
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: input.chatId,
        message: input.message,
        clientMessageId: createClientMessageId(),
        projectIds: [],
        attachments: [],
        ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    })
  } catch {
    if (input.signal?.aborted) return { ok: false, error: "", paused: true }
    return { ok: false, error: "Blitz could not reach the tutor. Try again." }
  }
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown
    } | null
    return {
      ok: false,
      error:
        typeof payload?.error === "string"
          ? payload.error
          : "The tutor could not start. Try again.",
    }
  }
  let failure: string | undefined
  try {
    await readChatStream(response.body, (value) => {
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "error" &&
        "message" in value &&
        typeof value.message === "string"
      )
        failure = value.message
    })
  } catch {
    if (input.signal?.aborted) return { ok: false, error: "", paused: true }
    return { ok: false, error: "The connection to the tutor dropped. Try again." }
  }
  return failure ? { ok: false, error: failure } : { ok: true }
}
