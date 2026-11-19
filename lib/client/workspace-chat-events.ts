/**
 * Reads the newline-delimited events that `/api/chat` streams back to the chat
 * workspace, and checks each one before the interface trusts it. Agent requests
 * saved on a message are read through the same check.
 */
import type { Id } from "../../convex/_generated/dataModel"
import type { AgentRequest } from "../agent-request"
import type { ProviderActivityEvent } from "../provider-activity"

/** Narrow event shapes returned by the workspace chat stream. */
export type ChatEvent =
  | { type: "started"; chatId: Id<"workspaceChats"> }
  | { type: "delta"; text: string }
  | { type: "thought-delta"; text: string }
  | { type: "activity"; event: ProviderActivityEvent }
  | {
      type: "complete"
      chatId: Id<"workspaceChats">
      threadId: string
      durationMs?: number
    }
  | {
      type: "agent-request"
      chatId: Id<"workspaceChats">
      messageId: string
      request: AgentRequest
    }
  | { type: "agent-request-resolved"; requestId: string }
  | { type: "error"; message: string }

/** Converts persisted or streamed data into a safe composer request envelope. */
export function agentRequestFromValue(value: unknown): AgentRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.method !== "string" ||
    typeof candidate.details !== "string" ||
    typeof candidate.expiresAt !== "number" ||
    !["pending", "approved", "denied", "expired", "cancelled"].includes(
      String(candidate.status)
    )
  )
    return undefined
  const kind =
    candidate.kind === "question" ||
    candidate.kind === "form" ||
    candidate.kind === "url"
      ? candidate.kind
      : "approval"
  const title =
    typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : "Review needed"
  return {
    id: candidate.id,
    ...(typeof candidate.providerRequestId === "string"
      ? { providerRequestId: candidate.providerRequestId }
      : {}),
    method: candidate.method,
    kind,
    title,
    details: candidate.details,
    ...(typeof candidate.prompt === "string"
      ? { prompt: candidate.prompt }
      : {}),
    ...(typeof candidate.input === "string" ? { input: candidate.input } : {}),
    expiresAt: candidate.expiresAt,
    status: candidate.status as AgentRequest["status"],
    ...(typeof candidate.response === "string"
      ? { response: candidate.response }
      : {}),
    ...(typeof candidate.createdAt === "number"
      ? { createdAt: candidate.createdAt }
      : {}),
    ...(typeof candidate.completedAt === "number"
      ? { completedAt: candidate.completedAt }
      : {}),
  }
}

/** Parses one server event and rejects malformed stream data. */
export function parseChatEvent(value: unknown): ChatEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Blitz returned an invalid response.")
  const event = value as Record<string, unknown>
  if (event.type === "started" && typeof event.chatId === "string")
    return { type: "started", chatId: event.chatId as Id<"workspaceChats"> }
  if (event.type === "delta" && typeof event.text === "string")
    return { type: "delta", text: event.text }
  if (event.type === "thought-delta" && typeof event.text === "string")
    return { type: "thought-delta", text: event.text }
  if (
    event.type === "activity" &&
    event.event &&
    typeof event.event === "object" &&
    !Array.isArray(event.event)
  ) {
    const activity = event.event as Record<string, unknown>
    if (
      typeof activity.id === "string" &&
      activity.type === "tool" &&
      typeof activity.title === "string" &&
      (activity.status === "running" ||
        activity.status === "completed" ||
        activity.status === "failed") &&
      (activity.detail === undefined || typeof activity.detail === "string")
    )
      return {
        type: "activity",
        event: {
          id: activity.id,
          type: "tool",
          title: activity.title,
          status: activity.status,
          ...(typeof activity.detail === "string"
            ? { detail: activity.detail }
            : {}),
        },
      }
  }
  if (
    event.type === "complete" &&
    typeof event.chatId === "string" &&
    typeof event.threadId === "string"
  )
    return {
      type: "complete",
      chatId: event.chatId as Id<"workspaceChats">,
      threadId: event.threadId,
      ...(typeof event.durationMs === "number"
        ? { durationMs: event.durationMs }
        : {}),
    }
  if (
    event.type === "agent-request" &&
    typeof event.chatId === "string" &&
    typeof event.messageId === "string" &&
    event.request &&
    typeof event.request === "object"
  ) {
    const request = agentRequestFromValue(event.request)
    if (request?.status === "pending")
      return {
        type: "agent-request",
        chatId: event.chatId as Id<"workspaceChats">,
        messageId: event.messageId,
        request,
      }
  }
  // Keep an in-flight browser compatible with the previous approval event name.
  if (
    event.type === "approval" &&
    typeof event.chatId === "string" &&
    typeof event.messageId === "string" &&
    event.approval &&
    typeof event.approval === "object"
  ) {
    const request = agentRequestFromValue({
      ...(event.approval as Record<string, unknown>),
      kind: "approval",
    })
    if (request?.status === "pending")
      return {
        type: "agent-request",
        chatId: event.chatId as Id<"workspaceChats">,
        messageId: event.messageId,
        request,
      }
  }
  if (
    event.type === "agent-request-resolved" &&
    typeof event.requestId === "string"
  )
    return { type: "agent-request-resolved", requestId: event.requestId }
  if (
    event.type === "approval-resolved" &&
    typeof event.approvalId === "string"
  )
    return { type: "agent-request-resolved", requestId: event.approvalId }
  if (event.type === "error" && typeof event.message === "string")
    return { type: "error", message: event.message }
  throw new Error("Blitz returned an invalid response.")
}

/** Reads newline-delimited events without assuming network chunk boundaries. */
export async function readChatEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      let newline = pending.indexOf("\n")
      while (newline >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.trim()) onEvent(parseChatEvent(JSON.parse(line)))
        newline = pending.indexOf("\n")
      }
      if (done) break
    }
    if (pending.trim()) onEvent(parseChatEvent(JSON.parse(pending)))
  } finally {
    reader.releaseLock()
  }
}

