/** Owns the native adapter for the persisted card-chat endpoints and live reply stream. */

import { fetch as streamingFetch } from "expo/fetch"
import { watchChatStream } from "../../lib/chat-stream"
import { randomUUID } from "expo-crypto"

import { MobileApiError } from "./api"

/** A persisted learner-authored chat message returned by the server. */
export type MobileChatMessage = {
  readonly id: string
  readonly clientMessageId: string
  readonly question: string
  readonly status: "queued" | "running" | "completed" | "failed"
  readonly reply?: string
  readonly error?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** Conversation-level status returned while the local worker processes a chat. */
export type MobileChatStatus = "idle" | "queued" | "running" | "failed"

/** The bounded GET response for one card conversation. */
export type MobileChatResponse = {
  readonly conversationId: string | null
  readonly codexThreadId: string | null
  readonly status: MobileChatStatus
  readonly lastError: string | null
  readonly messages: MobileChatMessage[]
}

/** The POST response returned when a learner question is queued. */
export type MobileChatEnqueueResponse = {
  readonly conversationId: string
  readonly message: MobileChatMessage
  readonly alreadyQueued: boolean
}

/** Reads a non-empty bounded string from an untrusted response. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MobileApiError(`Server response is missing ${field}`)
  }
  return value
}

/** Returns true for a JSON object that can be safely inspected. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates one message without trusting server-provided display fields. */
function parseMessage(value: unknown): MobileChatMessage {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid chat message")
  const status = requiredString(value.status, "chat message status")
  if (
    !(["queued", "running", "completed", "failed"] as string[]).includes(status)
  ) {
    throw new MobileApiError(
      "Server returned an unsupported chat message status"
    )
  }
  if (
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  ) {
    throw new MobileApiError("Server returned invalid chat message timestamps")
  }
  return {
    id: requiredString(value.id, "chat message id"),
    clientMessageId: requiredString(value.clientMessageId, "client message id"),
    question: requiredString(value.question, "chat question"),
    status: status as MobileChatMessage["status"],
    ...(typeof value.reply === "string" ? { reply: value.reply } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

/** Validates the conversation polling shape returned by GET /api/learning/chat. */
function parseChatResponse(value: unknown): MobileChatResponse {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new MobileApiError("Server returned an invalid chat response")
  }
  const status = value.status
  if (
    !(["idle", "queued", "running", "failed"] as unknown[]).includes(status)
  ) {
    throw new MobileApiError("Server returned an unsupported chat status")
  }
  return {
    conversationId:
      typeof value.conversationId === "string" ? value.conversationId : null,
    codexThreadId:
      typeof value.codexThreadId === "string" ? value.codexThreadId : null,
    status: status as MobileChatStatus,
    lastError: typeof value.lastError === "string" ? value.lastError : null,
    messages: value.messages.map(parseMessage),
  }
}

/** Reads JSON or turns a failed HTTP response into a safe native error. */
async function readJson(response: Response): Promise<unknown> {
  const body = await response.text()
  if (!response.ok) {
    let message = `Server request failed (${response.status})`
    try {
      const parsed = JSON.parse(body) as unknown
      if (isRecord(parsed) && typeof parsed.error === "string")
        message = parsed.error
    } catch {
      // Keep the status message when the server did not return JSON.
    }
    throw new MobileApiError(message)
  }
  try {
    return body ? (JSON.parse(body) as unknown) : undefined
  } catch {
    throw new MobileApiError("Server returned an unreadable response")
  }
}

/** Removes trailing slashes and validates a user-configured server URL. */
function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(normalized)) {
    throw new MobileApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  }
  return normalized
}

/** Loads the selected card's persisted chat conversation. */
export async function fetchChat(
  baseUrl: string,
  card: { readonly projectId: string; readonly id: string },
  signal?: AbortSignal
): Promise<MobileChatResponse> {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/learning/chat`)
  url.searchParams.set("projectId", card.projectId)
  url.searchParams.set("itemId", card.id)
  try {
    const response = await fetch(url, { signal })
    return parseChatResponse(await readJson(response))
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new MobileApiError("Could not reach the learning server")
  }
}

/** Queues one learner question with a stable idempotency key. */
export async function enqueueChatQuestion(
  baseUrl: string,
  card: { readonly projectId: string; readonly id: string },
  question: string,
  clientMessageId = randomUUID()
): Promise<MobileChatEnqueueResponse> {
  const response = await postChat(baseUrl, "/api/learning/chat", {
    projectId: card.projectId,
    itemId: card.id,
    clientMessageId,
    question,
  })
  if (!isRecord(response) || typeof response.conversationId !== "string") {
    throw new MobileApiError("Server returned an invalid chat enqueue response")
  }
  return {
    conversationId: response.conversationId,
    message: parseMessage(response.message),
    alreadyQueued: response.alreadyQueued === true,
  }
}

/** Requeues one failed message through POST /api/learning/chat/retry. */
export async function retryChatMessage(
  baseUrl: string,
  card: { readonly projectId: string; readonly id: string },
  messageId: string
): Promise<void> {
  await postChat(baseUrl, "/api/learning/chat/retry", {
    projectId: card.projectId,
    itemId: card.id,
    messageId,
  })
}

/** Sends one bounded JSON request to a chat endpoint. */
async function postChat(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<unknown> {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return readJson(response)
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not reach the learning server")
  }
}

/** Streams validated conversation snapshots until the native sheet closes. */
export function watchChat(
  baseUrl: string,
  card: { projectId: string; id: string },
  signal: AbortSignal,
  onSnapshot: (value: MobileChatResponse) => void,
  onError: (message: string) => void
): Promise<void> {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/learning/chat`)
  url.searchParams.set("projectId", card.projectId)
  url.searchParams.set("itemId", card.id)
  url.searchParams.set("stream", "1")
  return watchChatStream(url.toString(), {
    signal,
    fetcher: streamingFetch as typeof fetch,
    onSnapshot: (value) => onSnapshot(parseChatResponse(value)),
    onError,
  })
}
