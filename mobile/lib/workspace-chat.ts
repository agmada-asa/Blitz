/**
 * Owns the native transport, server history bridge, and bounded local cache for
 * the general workspace chat.
 * The existing card-chat adapter remains separate because it uses a different server contract.
 */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { fetch as streamingFetch } from "expo/fetch"
import { randomUUID } from "expo-crypto"

import { MobileApiError } from "./api"

/** One message in a persisted workspace transcript. */
export type WorkspaceChatMessage = {
  readonly id: string
  readonly serverId?: string
  readonly clientMessageId: string
  readonly role: "user" | "assistant"
  readonly content: string
  readonly status: "running" | "completed" | "failed"
  readonly error?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** A saved workspace conversation shown in the native history drawer. */
export type WorkspaceChat = {
  readonly id: string
  readonly title: string
  readonly projectId?: string
  readonly projectTitle?: string
  readonly status: "idle" | "running" | "failed"
  readonly updatedAt: number
  readonly messages: WorkspaceChatMessage[]
}

/** Project metadata accepted by the workspace attachment control. */
export type WorkspaceChatProject = {
  readonly id: string
  readonly title: string
}

/** Input accepted by the existing `/api/chat` stream. */
export type WorkspaceChatSendInput = {
  readonly chatId?: string
  readonly projectIds: string[]
  readonly continuationOf?: string
  readonly message?: string
  readonly clientMessageId: string
}

/** Events emitted by the newline-delimited workspace chat stream. */
export type WorkspaceChatEvent =
  | {
      readonly type: "started"
      readonly chatId: string
      readonly messageId?: string
    }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "complete"; readonly chatId: string }
  | { readonly type: "error"; readonly message: string }

/** Operations the screen needs from its native workspace transport. */
export type WorkspaceChatTransport = {
  readonly loadChats: () => Promise<WorkspaceChat[]>
  readonly loadChat?: (chatId: string) => Promise<WorkspaceChat>
  readonly loadProjects: () => Promise<WorkspaceChatProject[]>
  readonly send: (
    input: WorkspaceChatSendInput,
    signal: AbortSignal,
    onEvent: (event: WorkspaceChatEvent) => void
  ) => Promise<void>
  readonly saveChat: (chat: WorkspaceChat) => Promise<void>
}

const CACHE_VERSION = 1
const MAX_CACHED_CHATS = 60

/** Removes trailing slashes and rejects an unsafe server identity. */
function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(normalized)) {
    throw new MobileApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  }
  return normalized
}

/** Returns true when an unknown value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads a required non-empty string from an untrusted response. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MobileApiError(`Server response is missing ${field}`)
  }
  return value
}

/** Reads a JSON response and returns a safe native error for failed requests. */
async function readJson(response: Response): Promise<unknown> {
  const body = await response.text()
  if (!response.ok)
    throw new MobileApiError(`Server request failed (${response.status})`)
  try {
    return body ? (JSON.parse(body) as unknown) : undefined
  } catch {
    throw new MobileApiError("Server returned an unreadable response")
  }
}

/** Parses one project returned by the existing mobile-safe project route. */
function parseProject(value: unknown): WorkspaceChatProject {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid project")
  return {
    id: requiredString(value.id, "project id"),
    title: requiredString(value.title, "project title"),
  }
}

/** Parses a stream event and rejects malformed provider output. */
function parseEvent(value: unknown): WorkspaceChatEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new MobileApiError("Server returned an invalid chat event")
  }
  if (value.type === "started" && typeof value.chatId === "string")
    return {
      type: "started",
      chatId: value.chatId,
      ...(typeof value.messageId === "string"
        ? { messageId: value.messageId }
        : {}),
    }
  if (value.type === "delta" && typeof value.text === "string")
    return { type: "delta", text: value.text }
  if (value.type === "complete" && typeof value.chatId === "string")
    return { type: "complete", chatId: value.chatId }
  if (value.type === "error" && typeof value.message === "string")
    return { type: "error", message: value.message }
  throw new MobileApiError("Server returned an unsupported chat event")
}

/** Reads newline-delimited events without assuming network chunk boundaries. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WorkspaceChatEvent) => void
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
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) onEvent(parseEvent(JSON.parse(line) as unknown))
        newline = pending.indexOf("\n")
      }
      if (done) break
    }
    if (pending.trim()) onEvent(parseEvent(JSON.parse(pending) as unknown))
  } finally {
    reader.releaseLock()
  }
}

/** Returns a bounded, server-scoped AsyncStorage key. */
function cacheKey(baseUrl: string): string {
  return `@blitz/mobile/workspace-chat-v${CACHE_VERSION}:${encodeURIComponent(normalizeBaseUrl(baseUrl))}`
}

/** Validates cached history while dropping malformed entries from older builds. */
function parseCachedChats(value: unknown): WorkspaceChat[] {
  if (!Array.isArray(value)) return []
  return value.filter((chat): chat is WorkspaceChat => {
    if (
      !isRecord(chat) ||
      typeof chat.id !== "string" ||
      typeof chat.title !== "string"
    )
      return false
    if (!Array.isArray(chat.messages)) return false
    return chat.messages.every(
      (message) =>
        isRecord(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        typeof message.createdAt === "number"
    )
  })
}

/** Parses one bounded server transcript into the native chat shape. */
function parseRemoteChat(value: unknown): WorkspaceChat {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !Array.isArray(value.messages)
  )
    throw new MobileApiError("Server returned an invalid chat transcript")
  const messages = value.messages.flatMap((message) => {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    )
      return []
    const createdAt =
      typeof message.createdAt === "number" ? message.createdAt : Date.now()
    return [
      {
        id: message.id,
        serverId: message.id,
        clientMessageId: message.id,
        role: message.role,
        content: message.content,
        status:
          message.status === "running" || message.status === "failed"
            ? message.status
            : "completed",
        createdAt,
        updatedAt:
          typeof message.updatedAt === "number" ? message.updatedAt : createdAt,
      } satisfies WorkspaceChatMessage,
    ]
  })
  return {
    id: value.id,
    title: value.title,
    ...(typeof value.projectId === "string"
      ? { projectId: value.projectId }
      : {}),
    ...(typeof value.projectTitle === "string"
      ? { projectTitle: value.projectTitle }
      : {}),
    status:
      value.status === "running" || value.status === "failed"
        ? value.status
        : "idle",
    updatedAt:
      typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
    messages,
  }
}

/** Reads locally cached transcripts without making a network request. */
async function loadCachedChats(baseUrl: string): Promise<WorkspaceChat[]> {
  const raw = await AsyncStorage.getItem(cacheKey(baseUrl))
  if (!raw) return []
  try {
    return parseCachedChats(JSON.parse(raw) as unknown).sort(
      (a, b) => b.updatedAt - a.updatedAt
    )
  } catch {
    return []
  }
}

/** Creates the default workspace adapter for a configured Blitz server. */
export function createWorkspaceChatTransport(
  baseUrl: string
): WorkspaceChatTransport {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

  /** Loads server history first and merges locally cached streamed text for offline continuity. */
  async function loadChats(): Promise<WorkspaceChat[]> {
    try {
      const response = await fetch(`${normalizedBaseUrl}/api/mobile/chats`)
      const value = await readJson(response)
      if (!Array.isArray(value))
        throw new MobileApiError("Server returned invalid chat history")
      const remoteChats = value.flatMap((chat) => {
        if (
          !isRecord(chat) ||
          typeof chat.id !== "string" ||
          typeof chat.title !== "string"
        )
          return []
        return [
          {
            id: chat.id,
            title: chat.title,
            ...(typeof chat.projectId === "string"
              ? { projectId: chat.projectId }
              : {}),
            ...(typeof chat.projectTitle === "string"
              ? { projectTitle: chat.projectTitle }
              : {}),
            status:
              chat.status === "running" || chat.status === "failed"
                ? chat.status
                : "idle",
            updatedAt:
              typeof chat.updatedAt === "number" ? chat.updatedAt : Date.now(),
            messages: [],
          } satisfies WorkspaceChat,
        ]
      })
      const cached = await loadCachedChats(normalizedBaseUrl)
      if (!cached.length) return remoteChats
      const cachedById = new Map(cached.map((chat) => [chat.id, chat]))
      return remoteChats.map((chat) => cachedById.get(chat.id) ?? chat)
    } catch {
      return loadCachedChats(normalizedBaseUrl)
    }
  }

  /** Loads one complete server transcript after a history row is selected. */
  async function loadChat(chatId: string): Promise<WorkspaceChat> {
    const response = await fetch(
      `${normalizedBaseUrl}/api/mobile/chats?chatId=${encodeURIComponent(chatId)}`
    )
    return parseRemoteChat(await readJson(response))
  }

  /** Loads project metadata through the existing native-safe route. */
  async function loadProjects(): Promise<WorkspaceChatProject[]> {
    try {
      const response = await fetch(`${normalizedBaseUrl}/api/projects`)
      const value = await readJson(response)
      if (!Array.isArray(value))
        throw new MobileApiError("Server returned invalid projects")
      return value.map(parseProject)
    } catch (error) {
      if (error instanceof MobileApiError) throw error
      throw new MobileApiError("Could not reach the learning server")
    }
  }

  /** Streams one general workspace turn through the existing web chat route. */
  async function send(
    input: WorkspaceChatSendInput,
    signal: AbortSignal,
    onEvent: (event: WorkspaceChatEvent) => void
  ): Promise<void> {
    try {
      const response = await streamingFetch(`${normalizedBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          clientMessageId: input.clientMessageId,
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
          ...(input.continuationOf
            ? { continuationOf: input.continuationOf }
            : {}),
          projectIds: input.projectIds,
        }),
      })
      if (!response.ok || !response.body) {
        const value = await readJson(response).catch(() => undefined)
        throw new MobileApiError(
          isRecord(value) && typeof value.error === "string"
            ? value.error
            : "Blitz could not start that reply."
        )
      }
      await readEvents(response.body, onEvent)
    } catch (error) {
      if (error instanceof MobileApiError) throw error
      if (error instanceof Error && error.name === "AbortError") throw error
      throw new MobileApiError("Could not reach the learning server")
    }
  }

  /** Persists a bounded transcript so native history survives app restarts. */
  async function saveChat(chat: WorkspaceChat): Promise<void> {
    const chats = await loadCachedChats(normalizedBaseUrl)
    const next = [chat, ...chats.filter((current) => current.id !== chat.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CACHED_CHATS)
    await AsyncStorage.setItem(
      cacheKey(normalizedBaseUrl),
      JSON.stringify(next)
    )
  }

  return { loadChats, loadChat, loadProjects, send, saveChat }
}

/** Creates an empty local chat record with a stable ID before the first stream event. */
export function createWorkspaceChat(
  project?: WorkspaceChatProject
): WorkspaceChat {
  const now = Date.now()
  return {
    id: `local-${randomUUID()}`,
    title: "New chat",
    ...(project ? { projectId: project.id, projectTitle: project.title } : {}),
    status: "idle",
    updatedAt: now,
    messages: [],
  }
}
