"use client"

/** Owns persisted Blitz chat selection, streaming, and mixed-context attachments. */

import {
  Archive02Icon,
  ArrowDown01Icon,
  BookTextIcon,
  Chat01Icon,
  CheckUnread01Icon,
  Copy01Icon,
  Download01Icon,
  Delete02Icon,
  File01Icon,
  Folder01Icon,
  Link02Icon,
  Menu01Icon,
  MoreHorizontalIcon,
  PauseIcon,
  PencilEdit02Icon,
  Pin02Icon,
  PlayIcon,
  PlusIcon,
  QuoteUpIcon,
  SendIcon,
  SplitIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useMutation, useQuery } from "convex/react"
import Link from "next/link"
import Image from "next/image"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react"

import {
  ChatHistory,
  type ChatHistoryItem,
} from "@/components/chat/chat-history"
import { ArchivedChatsDialog } from "@/components/chat/archived-chats-dialog"
import {
  NewChatDialog,
  type NewChatProject,
} from "@/components/chat/new-chat-dialog"
import { AgentRequestPanel } from "@/components/chat/agent-request-panel"
import {
  ChatAgentControls,
  type ChatAgentAutonomy,
  type ChatAgentProject,
  readCachedAgentAutonomy,
  useCachedAgentAutonomy,
  writeCachedAgentAutonomy,
} from "@/components/chat/chat-agent-controls"
import { AnnotatedAssistantMessage } from "@/components/chat/annotated-assistant-message"
import { ReadAloudButton } from "@/components/chat/read-aloud-button"
import { type FloatingAnnotation } from "@/components/chat/floating-annotation-chip"
import { ReplyModelPicker } from "@/components/chat/reply-model-picker"
import { Markdown } from "@/components/ui/markdown"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { type ChatAnnotation } from "@/components/ui/markdown"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  SourcePane,
  type SourceSelection,
} from "@/components/chat/source-pane"
import { ThoughtTrace } from "@/components/chat/thought-trace"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { CancelIcon, LoadingIcon, SparklesIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { extractSourceResponse } from "@/lib/client/extract-source"
import {
  type AgentRequest,
  type AgentRequestSubmission,
} from "@/lib/agent-request"
import { cn } from "@/lib/utils"
import type { ProviderActivityEvent } from "@/lib/provider-activity"
import {
  clipboardImageFiles,
  droppedFiles,
} from "@/lib/client/chat-composer-input"

/** Maximum project collections accepted with one message. */
const MAX_PROJECT_ATTACHMENTS = 3
/** Maximum extracted characters retained for one browser-owned attachment. */
const MAX_ATTACHMENT_TEXT = 48_000
/** Maximum inline file and link text sent with one message. */
const MAX_INLINE_CONTEXT = 96_000

/** One unsent card, project, file, or public link shown above the composer. */
type DraftAttachment = {
  documentId?: Id<"chatDocuments">
  ownerToken?: string
  id: string
  kind: "card" | "project" | "file" | "link"
  label: string
  projectId?: Id<"projects">
  itemId?: Id<"learningItems">
  mimeType?: string
  previewUrl?: string
  text?: string
  url?: string
}

/** MIME types that can be previewed and delivered as native provider images. */
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

/** Returns whether a browser file is a supported native image attachment. */
function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type.toLowerCase())
}

/** Narrow event shapes returned by the workspace chat stream. */
type ChatEvent =
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

/** Initial saved chat selected by the route query string. */
type ChatWorkspaceProps = {
  initialChatId?: Id<"workspaceChats">
  initialCard?: ChatCard
  /** Optional unsent prompt used when a card starts a focused chat. */
  initialPrompt?: string
  initialProject?: ChatAgentProject
  /** Removes the full-page history rail and fits chat inside another panel. */
  embedded?: boolean
  /** Lets an owning panel open citations in its own source tab. */
  onOpenSource?: (selection: SourceSelection) => void
}

/** Optional overrides for standard, edited, and continued chat submissions. */
type SendMessageOptions = {
  message?: string
  chatId?: Id<"workspaceChats">
  continuationOf?: Id<"workspaceChatMessages">
  steeringPrompt?: string
  attachments?: DraftAttachment[]
  annotations?: FloatingAnnotation[]
}

/** In-flight queued message waiting to send once the active response finishes. */
type QueuedChatMessage = {
  id: string
  message: string
  attachments: DraftAttachment[]
  annotations: FloatingAnnotation[]
}

/** Card identity shown while a new card chat waits for its first question. */
type ChatCard = {
  id: Id<"learningItems">
  projectId: Id<"projects">
  title: string
  sourceLabel: string
}

/** Converts a card deep link into a locked draft attachment for a new chat. */
function draftAttachmentForCard(card: ChatCard): DraftAttachment {
  return {
    id: `card:${card.projectId}:${card.id}`,
    kind: "card",
    label: card.title,
    projectId: card.projectId,
    itemId: card.id,
  }
}

/** Returns a readable error without exposing an arbitrary response object. */
function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

/** Formats a message creation time as a local 24-hour clock value. */
function formatMessageTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(timestamp)
}

/** Converts persisted or streamed data into a safe composer request envelope. */
function agentRequestFromValue(value: unknown): AgentRequest | undefined {
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

/** Copies text on localhost and LAN browsers that lack the async Clipboard API. */
async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // LAN HTTP pages may expose the API but reject writes as an insecure context.
    }
  }
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()
  if (!copied) throw new Error("Clipboard access is unavailable")
}

/** Parses one server event and rejects malformed stream data. */
function parseChatEvent(value: unknown): ChatEvent {
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
async function readChatEvents(
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

/** Subscribes to platform changes (static across browser runtime). */
function subscribeToPlatform() {
  return () => {}
}

/** Reads whether the client platform is macOS or iOS. */
function getPlatformIsMac(): boolean {
  return typeof navigator !== "undefined"
    ? /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform || navigator.userAgent)
    : true
}

/** Default snapshot for server rendering (Mac desktop default). */
function getServerPlatformIsMac(): boolean {
  return true
}

/** Displays saved chat history beside the active conversation and composer. */
export function ChatWorkspace({
  initialChatId,
  initialCard,
  initialPrompt,
  initialProject,
  embedded = false,
  onOpenSource,
}: ChatWorkspaceProps) {
  const projects = useQuery(api.projects.listProjects)
  const chats = useQuery(api.workspaceChats.list, { archived: false }) as
    ChatHistoryItem[] | undefined
  const archivedChats = useQuery(api.workspaceChats.list, {
    archived: true,
  }) as ChatHistoryItem[] | undefined
  const archivedCount = archivedChats?.length ?? 0
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const conversationRef = useRef<HTMLElement>(null)
  const requestControllerRef = useRef<AbortController | undefined>(undefined)
  const pausedByUserRef = useRef(false)
  const manuallyMarkedUnreadRef = useRef<Id<"workspaceChats"> | undefined>(
    undefined
  )
  const activeSendPromiseRef = useRef<Promise<boolean> | undefined>(undefined)
  const sendingRef = useRef(false)
  /** Blocks a second upload batch before the uploading state re-renders. */
  const uploadingFilesRef = useRef(false)
  const [queuedMessage, setQueuedMessage] = useState<QueuedChatMessage | undefined>(undefined)
  const queuedMessageRef = useRef<QueuedChatMessage | undefined>(undefined)
  const [dismissedContinuationId, setDismissedContinuationId] = useState<string>()
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const isMac = useSyncExternalStore(
    subscribeToPlatform,
    getPlatformIsMac,
    getServerPlatformIsMac
  )
  const branchChat = useMutation(api.workspaceChats.branch)
  const createProject = useMutation(api.projects.createProject)
  const renameChat = useMutation(api.workspaceChats.rename)
  const setChatUnread = useMutation(api.workspaceChats.setUnread)
  const setChatPinned = useMutation(api.workspaceChats.setPinned)
  const setChatArchived = useMutation(api.workspaceChats.setArchived)
  const deleteChat = useMutation(api.workspaceChats.remove)
  const [activeChatId, setActiveChatId] = useState<
    Id<"workspaceChats"> | undefined
  >(initialCard ? undefined : initialChatId)
  const activeChat = useQuery(
    api.workspaceChats.get,
    activeChatId ? { chatId: activeChatId } : "skip"
  )
  const [attachments, setAttachments] = useState<DraftAttachment[]>(() =>
    initialCard
      ? [draftAttachmentForCard(initialCard)]
      : initialProject
        ? [
            {
              id: `project:${initialProject._id}`,
              kind: "project",
              label: initialProject.title,
              projectId: initialProject._id,
            },
          ]
        : []
  )
  const [draft, setDraft] = useState(() => initialPrompt?.slice(0, 4_000) ?? "")
  const [draftAnnotations, setDraftAnnotations] = useState<
    FloatingAnnotation[]
  >([])
  const [expandedAnnotationId, setExpandedAnnotationId] = useState<
    string | undefined
  >()
  const [sending, setSending] = useState(false)
  const [savingReplySettings, setSavingReplySettings] = useState(false)
  const [messageActionId, setMessageActionId] = useState<string>()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [editingMessageId, setEditingMessageId] = useState<string>()
  const [editDraft, setEditDraft] = useState("")
  const [error, setError] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [sourceSelection, setSourceSelection] = useState<{
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    citationId: string
  }>()
  const [renameChatId, setRenameChatId] = useState<Id<"workspaceChats">>()
  const [renameDraft, setRenameDraft] = useState("")
  const [deleteChatId, setDeleteChatId] = useState<Id<"workspaceChats">>()
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [includeAgentActivity, setIncludeAgentActivity] = useState(true)
  const [exportNotice, setExportNotice] = useState("")
  const [deletingChat, setDeletingChat] = useState(false)
  const [archivedDialogOpen, setArchivedDialogOpen] = useState(false)
  const [chatActionPending, setChatActionPending] = useState(false)
  const [chatActionError, setChatActionError] = useState("")
  const cachedAgentAutonomy = useCachedAgentAutonomy()
  const [agentAutonomy, setAgentAutonomy] = useState<
    ChatAgentAutonomy | undefined
  >(undefined)
  const [agentInstructions, setAgentInstructions] = useState("")
  const [workingProjectId, setWorkingProjectId] = useState<
    Id<"projects"> | undefined
  >(initialCard?.projectId ?? initialProject?._id)
  const [agentSettingsTouched, setAgentSettingsTouched] = useState(false)
  const [streamAgentRequests, setStreamAgentRequests] = useState<
    Record<string, { request: AgentRequest; messageId: string }>
  >({})
  const [streamProviderEvents, setStreamProviderEvents] = useState<
    ProviderActivityEvent[]
  >([])
  const [approvalBusy, setApprovalBusy] = useState<string>()
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [newChatDialogOpen, setNewChatDialogOpen] = useState(false)
  const [newChatProjectId, setNewChatProjectId] = useState<
    Id<"projects"> | undefined
  >(initialCard?.projectId ?? initialProject?._id)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")
  const [importingLink, setImportingLink] = useState(false)
  const persistedAttachments = activeChat?.attachments ?? []
  const contextualAttachments = [
    ...attachments.filter(
      (attachment) =>
        attachment.kind === "card" || attachment.kind === "project"
    ),
    ...persistedAttachments.filter(
      (attachment) =>
        attachment.kind === "card" || attachment.kind === "project"
    ),
  ].filter(
    (attachment, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.kind === attachment.kind &&
          (candidate.itemId ?? candidate.projectId) ===
            (attachment.itemId ?? attachment.projectId)
      ) === index
  )
  const messages = activeChat?.messages ?? []
  /** Formats the loaded conversation as Markdown with optional agent activity. */
  const exportChatMarkdown = (): string => {
    const title = activeChat?.title?.trim() || "Chat"
    const sections = [`# ${title}`]
    for (const message of messages) {
      const heading = message.role === "user" ? "You" : "Blitz"
      sections.push(`## ${heading}\n\n${message.content || "_(No message text)_"}`)
      if (!includeAgentActivity || message.role !== "assistant") continue

      const thought = "thought" in message ? message.thought : undefined
      if (thought?.trim()) sections.push(`### Agent working\n\n${thought.trim()}`)

      const events = "providerEvents" in message && Array.isArray(message.providerEvents)
        ? (message.providerEvents as ProviderActivityEvent[])
        : []
      for (const event of events) {
        const detail = event.detail?.trim()
        sections.push(`### Tool: ${event.title} (${event.status})${detail ? `\n\n${detail}` : ""}`)
      }

      const requests = "agentRequests" in message && Array.isArray(message.agentRequests)
        ? message.agentRequests.map((value) => agentRequestFromValue(value)).filter((value): value is AgentRequest => value !== undefined)
        : []
      for (const request of requests) {
        sections.push(`### Agent request: ${request.title || request.method} (${request.status})\n\n${request.details}`)
      }
    }
    return `${sections.join("\n\n---\n\n")}\n`
  }

  /** Copies the chosen transcript to the clipboard and reports recoverable errors. */
  const copyExport = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(exportChatMarkdown())
      setExportNotice("Chat copied to clipboard.")
    } catch {
      setExportNotice("Clipboard access failed. Try downloading the Markdown file.")
    }
  }

  /** Downloads the chosen transcript as a Markdown file. */
  const downloadExport = (): void => {
    const blob = new Blob([exportChatMarkdown()], { type: "text/markdown;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${(activeChat?.title || "chat").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-|-$/g, "") || "chat"}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    setExportNotice("Markdown file downloaded.")
  }
  const userClientMessageIds = useMemo(
    () =>
      new Set(
        (activeChat?.messages ?? [])
          .filter((m) => m.role === "user" && m.clientMessageId)
          .map((m) => m.clientMessageId as string)
      ),
    [activeChat?.messages]
  )
  const hasOrphanPersistedAttachments =
    persistedAttachments.length > 0 &&
    !messages.some((m) => m.role === "user")
  const composerAttachments = [
    ...(hasOrphanPersistedAttachments ? persistedAttachments : []),
    ...attachments,
  ].filter(
    (attachment) =>
      attachment.kind !== "card" && attachment.kind !== "project"
  )
  const latestMessage = messages[messages.length - 1]
  const continuableMessage =
    latestMessage?.role === "assistant" &&
    latestMessage.status === "failed" &&
    Boolean(latestMessage.content) &&
    dismissedContinuationId !== latestMessage.id
      ? latestMessage
      : undefined
  const sentAnnotations = messages.flatMap((m) =>
    m.role === "user" && "annotations" in m && Array.isArray(m.annotations)
      ? (m.annotations as FloatingAnnotation[])
      : []
  )
  const allChatAnnotations: ChatAnnotation[] = [
    ...sentAnnotations.map((a, index) => ({
      id: a.id,
      number: a.number ?? index + 1,
      messageId: a.messageId,
      selectedText: a.selectedText,
      note: a.note,
      createdAt: a.createdAt,
    })),
    ...draftAnnotations.map((a) => ({
      id: a.id,
      number: a.number,
      messageId: a.messageId,
      selectedText: a.selectedText,
      note: a.note,
      createdAt: a.createdAt,
    })),
  ]

  /** Creates a new draft annotation anchored to the selected text on an assistant reply. */
  const addAnnotation = useCallback(
    (messageId: string, selectedText: string): void => {
      const id = crypto.randomUUID()
      const now = Date.now()
      setDraftAnnotations((prev) => {
        const cleaned = prev.filter((item) => item.note.trim().length > 0)
        return [
          ...cleaned.map((item, index) => ({
            ...item,
            number: index + 1,
          })),
          {
            id,
            number: cleaned.length + 1,
            messageId,
            selectedText,
            note: "",
            createdAt: now,
            isDraft: true,
          },
        ]
      })
      setExpandedAnnotationId(id)
    },
    [setDraftAnnotations, setExpandedAnnotationId]
  )

  /** Saves an edited note for one draft annotation, or deletes it if the note is empty. */
  const saveAnnotation = (id: string, note: string): void => {
    const trimmed = note.trim()
    if (!trimmed) {
      deleteAnnotation(id)
      return
    }
    setDraftAnnotations((prev) =>
      prev.map((item) => (item.id === id ? { ...item, note: trimmed } : item))
    )
    setExpandedAnnotationId(undefined)
  }

  /** Deletes one draft annotation and renumbers remaining draft annotations. */
  const deleteAnnotation = (id: string): void => {
    setDraftAnnotations((prev) => {
      const filtered = prev.filter((item) => item.id !== id)
      return filtered.map((item, index) => ({
        ...item,
        number: index + 1,
      }))
    })
    setExpandedAnnotationId((current) => (current === id ? undefined : current))
  }

  /** Toggles expansion of one floating annotation chip. */
  const toggleExpandAnnotation = (id: string): void => {
    setExpandedAnnotationId((current) => (current === id ? undefined : id))
  }
  const lastMessageContent = messages.at(-1)?.content
  const selectedProject = attachments.find(
    (attachment) => attachment.kind === "project" && attachment.projectId
  )
  const selectedCard = attachments.find(
    (attachment) => attachment.kind === "card" && attachment.itemId
  )
  const contextualCard =
    selectedCard ??
    persistedAttachments.find(
      (attachment) => attachment.kind === "card" && attachment.itemId
    )
  const contextualProject =
    selectedProject ??
    persistedAttachments.find(
      (attachment) => attachment.kind === "project" && attachment.projectId
    )
  const contextProjectId =
    contextualCard?.projectId ??
    contextualProject?.projectId ??
    activeChat?.projectId ??
    newChatProjectId
  const contextProject = projects?.find(
    (project) => project._id === contextProjectId
  )
  const contextProjectLabel =
    contextProject?.title ?? contextualProject?.label ?? "Project"
  const isStreaming = sending || activeChat?.status === "running"
  const isRunning =
    uploadingFiles ||
    importingLink ||
    sending ||
    activeChat?.status === "running" ||
    savingReplySettings ||
    Boolean(messageActionId)
  const persistedAgentRequestEntry =
    activeChat?.status === "running"
      ? messages.reduceRight<
          { request: AgentRequest; messageId: string } | undefined
        >((found, message) => {
          if (
            found ||
            message.role !== "assistant" ||
            message.status !== "running"
          )
            return found
          const request = agentRequestFromValue(
            "agentApproval" in message ? message.agentApproval : undefined
          )
          return request?.status === "pending"
            ? { request, messageId: message.id }
            : found
        }, undefined)
      : undefined
  const liveAgentRequestEntry = Object.values(streamAgentRequests).at(-1)
  const composerAgentRequestEntry =
    liveAgentRequestEntry ?? persistedAgentRequestEntry
  const visibleComposerRequest = activeChatId
    ? composerAgentRequestEntry
    : undefined
  const canAttachProject =
    attachments.filter((attachment) => attachment.kind === "project").length <
      MAX_PROJECT_ATTACHMENTS
  const renameTarget =
    chats?.find((chat) => chat.id === renameChatId) ??
    archivedChats?.find((chat) => chat.id === renameChatId)
  const deleteTarget =
    chats?.find((chat) => chat.id === deleteChatId) ??
    archivedChats?.find((chat) => chat.id === deleteChatId)
  const activeChatTarget =
    chats?.find((chat) => chat.id === activeChatId) ??
    archivedChats?.find((chat) => chat.id === activeChatId)

  const persistedAgentSettings = activeChat as
    | (typeof activeChat & {
        agentAutonomy?: ChatAgentAutonomy
        agentInstructions?: string
        workingProjectId?: Id<"projects">
      })
    | null
    | undefined
  const effectiveAgentAutonomy = agentSettingsTouched
    ? (agentAutonomy ?? cachedAgentAutonomy)
    : (persistedAgentSettings?.agentAutonomy ??
      agentAutonomy ??
      cachedAgentAutonomy)
  const effectiveAgentInstructions = agentSettingsTouched
    ? agentInstructions
    : (persistedAgentSettings?.agentInstructions ?? agentInstructions)
  const effectiveWorkingProjectId = agentSettingsTouched
    ? workingProjectId
    : (persistedAgentSettings?.workingProjectId ?? workingProjectId)
  /** Tracks whether the reader is near the latest message without moving their scroll position. */
  const updateScrollToBottomVisibility = useCallback((): void => {
    const container = conversationRef.current
    if (!container) return
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    setShowScrollToBottom(distanceFromBottom > 96)
  }, [])

  /** Follows new content only while the reader is already near the conversation bottom. */
  useEffect(() => {
    const container = conversationRef.current
    if (!container) return
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    if (distanceFromBottom <= 96) {
      messageEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" })
    }
    updateScrollToBottomVisibility()
  }, [messages.length, lastMessageContent, updateScrollToBottomVisibility])

  /** Moves the conversation to its latest content and restores automatic following. */
  const scrollToLatestMessage = (): void => {
    messageEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
    setShowScrollToBottom(false)
  }

  const isCurrentChatUnread = Boolean(
    activeChatTarget?.isUnread ?? activeChat?.isUnread
  )

  /** Clears the unread marker when viewing or focusing the active chat. */
  useEffect(() => {
    if (!activeChatId || !isCurrentChatUnread) return
    if (manuallyMarkedUnreadRef.current === activeChatId) return

    // If the document is hidden, wait until the user returns to this window or tab.
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    ) {
      const handleVisible = () => {
        if (document.visibilityState === "visible") {
          manuallyMarkedUnreadRef.current = undefined
          void setChatUnread({ chatId: activeChatId, unread: false }).catch(
            () => {}
          )
        }
      }
      document.addEventListener("visibilitychange", handleVisible, {
        once: true,
      })
      window.addEventListener("focus", handleVisible, { once: true })
      return () => {
        document.removeEventListener("visibilitychange", handleVisible)
        window.removeEventListener("focus", handleVisible)
      }
    }

    void setChatUnread({ chatId: activeChatId, unread: false }).catch(
      (cause) => {
        setError(
          messageForError(cause, "This chat could not be marked as read.")
        )
      }
    )
  }, [activeChatId, isCurrentChatUnread, setChatUnread])

  /** Selects one saved chat and mirrors it in the address bar. */
  const selectChat = (
    chatId: Id<"workspaceChats">,
    preserveQueue = false
  ): void => {
    manuallyMarkedUnreadRef.current = undefined
    void setChatUnread({ chatId, unread: false }).catch(() => {})
    setSourceSelection(undefined)
    setActiveChatId(chatId)
    if (!preserveQueue) {
      setQueuedMessage(undefined)
      queuedMessageRef.current = undefined
    }
    revokeDraftPreviews()
    setAttachments([])
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
    setDismissedContinuationId(undefined)
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setStreamAgentRequests({})
    setStreamProviderEvents([])
    setAgentAutonomy(undefined)
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    if (!embedded)
      window.history.replaceState(
        null,
        "",
        `/chat?chatId=${encodeURIComponent(chatId)}`
      )
  }

  /** Clears the active conversation and starts a new standalone chat. */
  const startNewChat = (): void => {
    if (isRunning) return
    setSourceSelection(undefined)
    setActiveChatId(undefined)
    setQueuedMessage(undefined)
    queuedMessageRef.current = undefined
    revokeDraftPreviews()
    setAttachments([])
    setDraft("")
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
    setDismissedContinuationId(undefined)
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setAgentAutonomy(readCachedAgentAutonomy())
    setAgentInstructions("")
    setWorkingProjectId(undefined)
    setNewChatProjectId(undefined)
    setStreamAgentRequests({})
    setStreamProviderEvents([])
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    setNewChatDialogOpen(false)
    if (!embedded) window.history.replaceState(null, "", "/chat")
  }

  /** Clears the composer and assigns the selected project to the pending chat. */
  const startNewChatForProject = (project: NewChatProject): void => {
    setSourceSelection(undefined)
    setActiveChatId(undefined)
    setQueuedMessage(undefined)
    queuedMessageRef.current = undefined
    setDismissedContinuationId(undefined)
    setAttachments([
      {
        id: `project:${project._id}`,
        kind: "project",
        label: project.title,
        projectId: project._id,
      },
    ])
    setDraft("")
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setAgentAutonomy(readCachedAgentAutonomy())
    setAgentInstructions("")
    setWorkingProjectId(project._id)
    setNewChatProjectId(project._id)
    setStreamAgentRequests({})
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    setNewChatDialogOpen(false)
    if (!embedded)
      window.history.replaceState(
        null,
        "",
        `/chat?projectId=${encodeURIComponent(project._id)}`
      )
  }

  /** Queues the draft message and attachments to send automatically once the active response completes. */
  const queueDraftMessage = (): void => {
    const message = draft.trim()
    const hasAttachments = attachments.length > 0
    const validAnnotations = draftAnnotations.filter(
      (annotation) => annotation.note.trim().length > 0
    )
    if (!message && !hasAttachments && validAnnotations.length === 0) return

    setQueuedMessage((prev) => {
      const combinedMessage = prev?.message
        ? `${prev.message}\n\n${message}`
        : message
      const combinedAttachments = [
        ...(prev?.attachments ?? []),
        ...attachments.filter(
          (attachment) =>
            !(prev?.attachments ?? []).some((item) => item.id === attachment.id)
        ),
      ]
      const combinedAnnotations = [
        ...(prev?.annotations ?? []),
        ...validAnnotations.filter(
          (annotation) =>
            !(prev?.annotations ?? []).some((item) => item.id === annotation.id)
        ),
      ]
      const nextQueued: QueuedChatMessage = {
        id: prev?.id ?? crypto.randomUUID(),
        message: combinedMessage,
        attachments: combinedAttachments,
        annotations: combinedAnnotations,
      }
      queuedMessageRef.current = nextQueued
      return nextQueued
    })

    setDraft("")
    setAttachments([])
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
  }

  /** Deletes the queued message before it is sent. */
  const deleteQueuedMessage = (): void => {
    setQueuedMessage(undefined)
    queuedMessageRef.current = undefined
  }

  /** Creates a project and returns the metadata needed to start its first chat. */
  const createNewChatProject = async (
    title: string
  ): Promise<NewChatProject> => {
    const projectId = await createProject({ title })
    return { _id: projectId, title: title.trim() }
  }

  /** Opens the rename form with the current title from chat history. */
  const openRenameChat = (chatId: Id<"workspaceChats">): void => {
    const chat = chats?.find((item) => item.id === chatId)
    if (!chat) return
    setRenameChatId(chatId)
    setRenameDraft(chat.title)
    setChatActionError("")
  }

  /** Saves the new chat title and leaves the dialog open when validation fails. */
  const saveChatName = async (): Promise<void> => {
    if (!renameChatId || chatActionPending) return
    const title = renameDraft.trim()
    if (!title) {
      setChatActionError("Enter a chat name.")
      return
    }
    setChatActionPending(true)
    setChatActionError("")
    try {
      await renameChat({ chatId: renameChatId, title })
      setRenameChatId(undefined)
    } catch (cause) {
      setChatActionError(
        messageForError(cause, "This chat could not be renamed.")
      )
    } finally {
      setChatActionPending(false)
    }
  }

  /** Changes a chat's unread marker from its context menu. */
  const toggleChatUnread = (
    chatId: Id<"workspaceChats">,
    unread: boolean
  ): void => {
    if (unread) {
      manuallyMarkedUnreadRef.current = chatId
    } else if (manuallyMarkedUnreadRef.current === chatId) {
      manuallyMarkedUnreadRef.current = undefined
    }
    void setChatUnread({ chatId, unread }).catch((cause) => {
      setError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Changes a chat's pinned state from its context menu. */
  const toggleChatPinned = (
    chatId: Id<"workspaceChats">,
    pinned: boolean
  ): void => {
    void setChatPinned({ chatId, pinned }).catch((cause) => {
      setError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Changes a chat's archive state from its context menu or actions menu. */
  const toggleChatArchived = (
    chatId: Id<"workspaceChats">,
    archived: boolean
  ): void => {
    void setChatArchived({ chatId, archived }).catch((cause) => {
      setError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Confirms and permanently removes a chat and its dependencies. */
  const confirmDeleteChat = async (): Promise<void> => {
    if (!deleteChatId || deletingChat) return
    setDeletingChat(true)
    try {
      const targetId = deleteChatId
      await deleteChat({ chatId: targetId })
      setDeleteChatId(undefined)
      if (activeChatId === targetId) {
        setActiveChatId(undefined)
      }
    } catch (cause) {
      setError(messageForError(cause, "This chat could not be deleted."))
    } finally {
      setDeletingChat(false)
    }
  }

  /** Adds an unsent attachment unless the same project or URL is already selected. */
  const addAttachment = (attachment: DraftAttachment): void => {
    setAttachments((current) => {
      if (
        current.some(
          (item) =>
            (attachment.projectId && item.projectId === attachment.projectId) ||
            (attachment.url && item.url === attachment.url)
        )
      )
        return current
      return [...current, attachment]
    })
  }

  /** Releases browser object URLs owned by unsent image previews. */
  const revokeDraftPreviews = (): void => {
    for (const attachment of attachments)
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
  }

  /** Saves selected originals before allowing a message to use them as source context. */
  const chooseFiles = async (files: File[]): Promise<void> => {
    if (uploadingFilesRef.current) return
    uploadingFilesRef.current = true
    setUploadingFiles(true)
    setError("")
    const selected = files
    const uploadProjectId = activeChat?.projectId ?? newChatProjectId ?? selectedProject?.projectId
    for (const file of selected) {
      try {
        const response = await fetch("/api/chat/files", {
          method: "POST",
          headers: {
            ...(uploadProjectId ? { "x-blitz-project-id": uploadProjectId } : {}),
            "x-blitz-filename": encodeURIComponent(file.name),
            "content-type": file.type || "application/octet-stream",
          },
          body: file,
        })
        const source = (await response.json()) as {
          documentId: Id<"chatDocuments">
          filename: string
          mimeType?: string
          ownerToken?: string
          error?: string
        }
        if (!response.ok)
          throw new Error(source.error || "File could not be attached.")
        addAttachment({
          id: crypto.randomUUID(),
          kind: "file",
          label: source.filename,
          documentId: source.documentId,
          ...(source.ownerToken ? { ownerToken: source.ownerToken } : {}),
          ...(isImageFile(file)
            ? {
                mimeType: source.mimeType ?? file.type,
                previewUrl: URL.createObjectURL(file),
              }
            : {}),
        })
      } catch (fileError) {
        setError(messageForError(fileError, `Could not read ${file.name}.`))
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
    uploadingFilesRef.current = false
    setUploadingFiles(false)
  }

  /** Handles files dropped anywhere on the chat pane while preserving ordinary text drops. */
  const handleComposerDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = droppedFiles(Array.from(event.dataTransfer.files))
    if (!files.length) return
    event.preventDefault()
    setDraggingFiles(false)
    if (!isRunning) void chooseFiles(files)
  }

  /** Handles clipboard screenshots without changing ordinary multiline text paste. */
  const handleComposerPaste = (
    event: ClipboardEvent<HTMLTextAreaElement>
  ): void => {
    const files = Array.from(event.clipboardData.files)
    if (!files.length || isRunning) return
    const images = clipboardImageFiles(files)
    if (!images.length) return
    event.preventDefault()
    void chooseFiles(images)
  }

  /** Fetches a public source through the protected route and attaches extracted text. */
  const attachLink = async (): Promise<void> => {
    const url = linkUrl.trim()
    if (!url || importingLink) return
    setImportingLink(true)
    setError("")
    try {
      const response = await fetch("/api/sources/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(result?.error || "That link could not be fetched.")
      }
      const originalResponse = response.clone()
      const source = await extractSourceResponse(response, url)
      if (!source.text.trim())
        throw new Error("There was no readable text at that link.")
      const remainingCharacters =
        MAX_INLINE_CONTEXT -
        attachments.reduce(
          (total, attachment) => total + (attachment.text?.length ?? 0),
          0
        )
      if (remainingCharacters <= 0)
        throw new Error("Remove a file or link before adding another.")
      let documentId: Id<"chatDocuments"> | undefined
      let ownerToken: string | undefined
      const projectId =
        activeChat?.projectId ?? newChatProjectId ?? selectedProject?.projectId
      if (/\.(pdf|pptx)$/i.test(source.filename)) {
        const saved = await fetch("/api/chat/files", {
          method: "POST",
          headers: {
            ...(projectId ? { "x-blitz-project-id": projectId } : {}),
            "x-blitz-filename": encodeURIComponent(source.filename),
            "content-type":
              originalResponse.headers.get("content-type") ||
              "application/octet-stream",
          },
          body: await originalResponse.blob(),
        })
        const payload = (await saved.json()) as {
          documentId?: Id<"chatDocuments">
          ownerToken?: string
          error?: string
        }
        if (!saved.ok)
          throw new Error(
            payload.error || "The original file could not be saved."
          )
        documentId = payload.documentId
        ownerToken = payload.ownerToken
      }
      addAttachment({
        id: crypto.randomUUID(),
        kind: "link",
        ...(documentId ? { documentId } : {}),
        ...(ownerToken ? { ownerToken } : {}),
        label: source.filename,
        text: source.text.slice(
          0,
          Math.min(MAX_ATTACHMENT_TEXT, remainingCharacters)
        ),
        url: response.headers.get("x-source-url") ?? url,
      })
      setLinkUrl("")
      setLinkDialogOpen(false)
    } catch (linkError) {
      setError(messageForError(linkError, "That link could not be attached."))
    } finally {
      setImportingLink(false)
    }
  }

  /** Sends a standard, edited, or continuation turn and lets Convex drive the transcript. */
  const sendMessage = async (
    options: SendMessageOptions = {}
  ): Promise<boolean> => {
    manuallyMarkedUnreadRef.current = undefined
    const submittedAnnotations =
      options.annotations ??
      (options.message === undefined && !options.continuationOf
        ? draftAnnotations.filter((a) => a.note.trim().length > 0)
        : [])
    const rawMessage = (options.message ?? draft).trim()
    const message = rawMessage
    const targetChatId = options.chatId ?? activeChatId
    const targetProjectId = targetChatId ? undefined : newChatProjectId
    if (
      (!message && !submittedAnnotations.length && !options.continuationOf) ||
      (!options.continuationOf && sendingRef.current) ||
      uploadingFiles ||
      importingLink ||
      savingReplySettings ||
      (!options.chatId && !options.continuationOf && activeChat?.status === "running") ||
      (options.continuationOf && !targetChatId)
    )
      return false
    const submittedAttachments =
      options.attachments ??
      (options.message === undefined && !options.continuationOf
        ? attachments
        : [])
    const cardAttachment = submittedAttachments.find(
      (attachment) =>
        attachment.kind === "card" && attachment.projectId && attachment.itemId
    )
    if (!options.continuationOf) {
      setDraft("")
      setAttachments([])
      setDraftAnnotations([])
      setExpandedAnnotationId(undefined)
    } else if (options.steeringPrompt) {
      setDraft("")
    }
    setError("")
    setStreamProviderEvents([])
    setSending(true)
    sendingRef.current = true
    pausedByUserRef.current = false
    const controller = new AbortController()
    requestControllerRef.current = controller
    let started = false
    let completed = false
    let resolvedChatId: Id<"workspaceChats"> | undefined = targetChatId

    const run = async (): Promise<boolean> => {
      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            ...(options.continuationOf ? {} : { message }),
            clientMessageId: crypto.randomUUID(),
            ...(targetChatId ? { chatId: targetChatId } : {}),
            ...(targetProjectId ? { projectId: targetProjectId } : {}),
            ...(options.continuationOf
              ? { continuationOf: options.continuationOf }
              : {}),
            ...(options.steeringPrompt
              ? { steeringPrompt: options.steeringPrompt }
              : {}),
            ...(cardAttachment?.projectId && cardAttachment.itemId
              ? {
                  card: {
                    projectId: cardAttachment.projectId,
                    itemId: cardAttachment.itemId,
                  },
                }
              : {}),
            projectIds: submittedAttachments.flatMap((attachment) =>
              attachment.kind === "project" && attachment.projectId
                ? [attachment.projectId]
                : []
            ),
            attachments: submittedAttachments.flatMap((attachment) =>
              attachment.kind !== "project" &&
              attachment.kind !== "card" &&
              (attachment.text || attachment.documentId)
                ? [
                    {
                      kind: attachment.kind,
                      label: attachment.label,
                      text: attachment.text,
                      ...(attachment.documentId
                        ? { documentId: attachment.documentId }
                        : {}),
                      ...(attachment.ownerToken
                        ? { ownerToken: attachment.ownerToken }
                        : {}),
                      ...(attachment.mimeType
                        ? { mimeType: attachment.mimeType }
                        : {}),
                      ...(attachment.url ? { url: attachment.url } : {}),
                    },
                  ]
                : []
            ),
            ...(submittedAnnotations.length
              ? {
                  annotations: submittedAnnotations.map((annotation) => ({
                    id: annotation.id,
                    number: annotation.number,
                    messageId: annotation.messageId,
                    selectedText: annotation.selectedText,
                    note: annotation.note,
                    createdAt: annotation.createdAt,
                  })),
                }
              : {}),
            autonomy: effectiveAgentAutonomy,
            additionalInstructions: effectiveAgentInstructions,
            ...(effectiveWorkingProjectId
              ? { workingProjectId: effectiveWorkingProjectId }
              : {}),
          }),
        })
        if (!response.ok || !response.body) {
          const result = (await response.json().catch(() => null)) as {
            error?: string
          } | null
          throw new Error(result?.error || "Blitz could not start that reply.")
        }
        await readChatEvents(response.body, (event) => {
          if (event.type === "error") {
            if (pausedByUserRef.current || controller.signal.aborted) return
            throw new Error(event.message)
          }
          if (event.type === "started") {
            started = true
            resolvedChatId = event.chatId
            revokeDraftPreviews()
            setAttachments([])
            setDraftAnnotations([])
            setExpandedAnnotationId(undefined)
            selectChat(event.chatId, true)
            setStreamProviderEvents([])
          }
          if (event.type === "activity")
            setStreamProviderEvents((current) => {
              const index = current.findIndex((item) => item.id === event.event.id)
              if (index >= 0) {
                const next = [...current]
                next[index] = event.event
                return next
              }
              return [...current, event.event].slice(-64)
            })
          if (event.type === "agent-request") {
            setStreamAgentRequests((current) => ({
              ...current,
              [event.request.id]: {
                request: event.request,
                messageId: event.messageId,
              },
            }))
          }
          if (event.type === "agent-request-resolved") {
            setStreamAgentRequests((current) => {
              const next = { ...current }
              delete next[event.requestId]
              return next
            })
          }
        })
        if (!started && !targetChatId)
          throw new Error("Blitz ended the reply early.")
        completed = true
        setDismissedContinuationId(undefined)

        if (queuedMessageRef.current && resolvedChatId) {
          const queued = queuedMessageRef.current
          setQueuedMessage(undefined)
          queuedMessageRef.current = undefined
          setTimeout(() => {
            void sendMessage({
              chatId: resolvedChatId,
              message: queued.message,
              attachments: queued.attachments,
              annotations: queued.annotations,
            })
          }, 50)
        }
      } catch (sendError) {
        const paused = controller.signal.aborted || pausedByUserRef.current
        if (!paused)
          setError(
            messageForError(
              sendError,
              "Blitz could not finish that reply. Try again."
            )
          )
        if (!started && !options.continuationOf) {
          setDraft(rawMessage)
          setDraftAnnotations(submittedAnnotations)
        } else if (!started && options.steeringPrompt) {
          setDraft(options.steeringPrompt)
        }
      } finally {
        if (requestControllerRef.current === controller)
          requestControllerRef.current = undefined
        pausedByUserRef.current = false
        sendingRef.current = false
        setSending(false)
      }
      return completed
    }

    const sendPromise = run()
    activeSendPromiseRef.current = sendPromise
    return await sendPromise
  }

  /** Copies one user or assistant message and confirms the action inline. */
  const copyMessage = async (
    messageId: string,
    content: string
  ): Promise<void> => {
    try {
      await writeClipboardText(content)
      setCopiedMessageId(messageId)
    } catch {
      setError("This message could not be copied.")
    }
  }

  /** Opens the selected user message in its inline edit field. */
  const beginEditing = (messageId: string, content: string): void => {
    setEditingMessageId(messageId)
    setEditDraft(content)
    setError("")
  }

  /** Creates a preserved branch, then submits the edited user message there. */
  const saveEditedMessage = async (
    messageId: Id<"workspaceChatMessages">
  ): Promise<void> => {
    const message = editDraft.trim()
    if (!activeChatId || !message || isRunning || messageActionId) return
    setMessageActionId(messageId)
    setError("")
    try {
      const branch = await branchChat({
        chatId: activeChatId,
        messageId,
        includeMessage: false,
        editedMessage: message,
      })
      selectChat(branch.chatId)
      await sendMessage({ message, chatId: branch.chatId })
    } catch (editError) {
      setError(messageForError(editError, "That message could not be edited."))
    } finally {
      setMessageActionId(undefined)
    }
  }

  /** Copies the transcript through one model response into a new saved chat. */
  const branchFromResponse = async (
    messageId: Id<"workspaceChatMessages">
  ): Promise<void> => {
    if (!activeChatId || isRunning || messageActionId) return
    setMessageActionId(messageId)
    setError("")
    try {
      const branch = await branchChat({
        chatId: activeChatId,
        messageId,
        includeMessage: true,
      })
      selectChat(branch.chatId)
    } catch (branchError) {
      setError(
        messageForError(branchError, "That response could not be branched.")
      )
    } finally {
      setMessageActionId(undefined)
    }
  }

  /** Requests exact server cancellation, then stops local delivery even after a reload. */
  const pauseReply = (): void => {
    const runningMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.status === "running"
      )
    if (!activeChatId || !runningMessage) return
    pausedByUserRef.current = true
    requestControllerRef.current?.abort()
    void fetch("/api/chat/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId: activeChatId,
        messageId: runningMessage.id,
      }),
    })
      .then((response) => {
        if (!response.ok)
          throw new Error(
            "This reply could not be paused. Its provider session may have ended; reload the chat to check its status."
          )
      })
      .catch((pauseError: unknown) => {
        setError(
          messageForError(
            pauseError,
            "The reply could not be paused. Try again."
          )
        )
      })
  }

  /** Resolves a pending agent request for the current chat message. */
  const decideAgentRequest = async (
    request: AgentRequest,
    messageId: string,
    submission: AgentRequestSubmission
  ): Promise<void> => {
    if (!activeChatId) return
    setApprovalBusy(request.id)
    setError("")
    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          messageId,
          approvalId: request.id,
          decision: submission.decision,
          ...(submission.response !== undefined
            ? { response: submission.response }
            : {}),
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      if (!response.ok)
        throw new Error(
          payload?.error || "Agent request could not be resolved."
        )
      setStreamAgentRequests((current) => {
        const next = { ...current }
        delete next[request.id]
        return next
      })
    } catch (cause) {
      setError(messageForError(cause, "Agent request could not be resolved."))
    } finally {
      setApprovalBusy(undefined)
    }
  }

  /** Resumes the latest interrupted response in the same assistant message, optionally steered with notes. */
  const continueResponse = async (
    messageId: Id<"workspaceChatMessages">,
    steeringPrompt?: string
  ): Promise<void> => {
    if (!activeChatId || isRunning || messageActionId) return
    setMessageActionId(messageId)
    try {
      await sendMessage({
        chatId: activeChatId,
        continuationOf: messageId,
        steeringPrompt: steeringPrompt?.trim() || undefined,
      })
      if (steeringPrompt) {
        setDraft("")
      }
    } finally {
      setMessageActionId(undefined)
    }
  }

  /** Pauses the in-flight reply and continues with the learner's steering notes. */
  const hotSteerReply = async (): Promise<void> => {
    const runningMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant" && message.status === "running"
      )
    if (!activeChatId || !runningMessage) return
    const steeringNotes = draft.trim()
    if (!steeringNotes) return
    setDraft("")
    pausedByUserRef.current = true
    setMessageActionId(runningMessage.id)
    try {
      requestControllerRef.current?.abort()
      const response = await fetch("/api/chat/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          messageId: runningMessage.id,
        }),
      })
      if (!response.ok) {
        throw new Error(
          "This reply could not be paused for steering. Its provider session may have ended; reload the chat to check its status."
        )
      }
      if (activeSendPromiseRef.current) {
        await activeSendPromiseRef.current.catch(() => {})
      }
      sendingRef.current = false
      await sendMessage({
        chatId: activeChatId,
        continuationOf: runningMessage.id,
        steeringPrompt: steeringNotes,
      })
    } catch (hotSteerError: unknown) {
      setDraft(steeringNotes)
      setError(
        messageForError(
          hotSteerError,
          "The reply could not be steered. Try again."
        )
      )
    } finally {
      setMessageActionId(undefined)
    }
  }

  /** Sends on Enter, queues while running, or hot-steers with ⌘Enter / Ctrl+Enter. */
  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    const isSteerModifier = event.metaKey || event.ctrlKey
    const isStreaming = sending || activeChat?.status === "running"

    if (event.key === "Enter") {
      // ⌘Enter on Mac or Ctrl+Enter on Windows/Linux
      if (isSteerModifier && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        if (isStreaming) {
          if (draft.trim()) {
            void hotSteerReply()
          }
        } else if (continuableMessage) {
          void continueResponse(
            continuableMessage.id,
            draft.trim() || undefined
          )
        } else {
          void sendMessage()
        }
        return
      }

      // Plain Enter without modifier keys
      if (!event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        if (isStreaming) {
          const hasDraftContent =
            Boolean(draft.trim()) ||
            attachments.length > 0 ||
            draftAnnotations.some((a) => a.note.trim().length > 0)
          if (hasDraftContent) {
            queueDraftMessage()
          }
        } else if (continuableMessage) {
          void continueResponse(
            continuableMessage.id,
            draft.trim() || undefined
          )
        } else {
          void sendMessage()
        }
      }
    }
  }

  const history = (
    <ChatHistory
      chats={chats}
      activeChatId={activeChatId}
      onSelect={selectChat}
      onNew={startNewChat}
      onNewInProject={startNewChatForProject}
      onRename={openRenameChat}
      onToggleUnread={toggleChatUnread}
      onTogglePin={toggleChatPinned}
      onToggleArchive={toggleChatArchived}
      onDelete={(id) => setDeleteChatId(id)}
      onOpenArchived={() => setArchivedDialogOpen(true)}
      archivedCount={archivedCount}
    />
  )

  return (
    <main
      className={cn(
        "flex min-h-0 w-full overflow-hidden",
        embedded
          ? "h-full"
          : "h-[calc(100svh-68px-env(safe-area-inset-bottom))] md:h-svh"
      )}
    >
      <aside
        className={cn(
          "hidden w-[276px] shrink-0 border-r border-border/70 bg-card/40 md:block",
          (embedded || sourceSelection) && "md:hidden"
        )}
      >
        {history}
      </aside>

      <div
        className={cn(
          "relative flex min-w-0 flex-1 flex-col",
          embedded ? "px-3" : "px-4 sm:px-8",
          draggingFiles && "bg-brand/5"
        )}
        onDragEnter={(event) => {
          event.preventDefault()
          if (
            !isRunning &&
            !continuableMessage &&
            event.dataTransfer.types.includes("Files")
          ) {
            setDraggingFiles(true)
          }
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setDraggingFiles(false)
        }}
        onDrop={handleComposerDrop}
      >
        {draggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-brand bg-background/80 backdrop-blur-xs">
            <div className="flex flex-col items-center gap-2 text-brand">
              <HugeiconsIcon icon={File01Icon} size={36} strokeWidth={1.8} />
              <p className="text-base font-medium">Drop files to attach</p>
            </div>
          </div>
        )}
        <header className="shrink-0">
          <div className="flex h-16 items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("shrink-0 rounded-full", !embedded && "md:hidden")}
                aria-label="Open chat history"
                onClick={() => setHistoryOpen(true)}
              >
                <HugeiconsIcon icon={Menu01Icon} size={18} strokeWidth={1.8} />
              </Button>
              <h1 className="min-w-0 flex-1 truncate text-xl font-medium tracking-tight">
                {activeChat?.title ?? "New chat"}
              </h1>
              <DropdownMenu>
                {activeChat ? (
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                      aria-label={`Actions for ${activeChat.title}`}
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                    </Button>
                  </DropdownMenuTrigger>
                ) : null}
                {activeChat ? (
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => openRenameChat(activeChat.id)}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={15} aria-hidden="true" />
                      Rename chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setIncludeAgentActivity(true)
                        setExportNotice("")
                        setExportDialogOpen(true)
                      }}
                    >
                      <HugeiconsIcon icon={Download01Icon} size={15} aria-hidden="true" />
                      Export chat
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        toggleChatUnread(
                          activeChat.id,
                          !(activeChatTarget?.isUnread ?? activeChat.isUnread)
                        )
                      }
                    >
                      <HugeiconsIcon icon={CheckUnread01Icon} size={15} aria-hidden="true" />
                      {activeChatTarget?.isUnread ?? activeChat.isUnread ? "Mark as read" : "Mark as unread"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => toggleChatPinned(activeChat.id, !activeChatTarget?.isPinned)}
                    >
                      <HugeiconsIcon icon={Pin02Icon} size={15} aria-hidden="true" />
                      {activeChatTarget?.isPinned ? "Unpin chat" : "Pin chat"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => toggleChatArchived(activeChat.id, !activeChat.isArchived)}
                    >
                      <HugeiconsIcon icon={Archive02Icon} size={15} aria-hidden="true" />
                      {activeChat.isArchived ? "Restore chat" : "Archive chat"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeleteChatId(activeChat.id)}>
                      <HugeiconsIcon icon={Delete02Icon} size={15} aria-hidden="true" />
                      Delete chat
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                ) : null}
              </DropdownMenu>
            </div>
            <Button
              type="button"
              variant="outline"
              className="shrink-0 rounded-full px-3 md:hidden"
              disabled={isRunning}
              onClick={startNewChat}
            >
              New chat
            </Button>
          </div>
          {contextualAttachments.length || contextProjectId ? (
            <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 px-1 pb-2">
              {contextProjectId ? (
                <Button asChild type="button" variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs">
                  <Link href={contextualCard
                    ? `/projects/${encodeURIComponent(contextProjectId)}/learn?resume=1`
                    : `/projects/${encodeURIComponent(contextProjectId)}`}>
                    ← {contextualCard ? "Lesson" : "Project"}
                  </Link>
                </Button>
              ) : null}
              {contextualAttachments.length ? (
                <ul aria-label="Chat context" className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {contextualAttachments.map((attachment) => {
                    const isDraft = attachments.some(
                      (item) => item.id === attachment.id
                    )
                    return (
                      <AttachmentChip
                        key={`${attachment.kind}:${attachment.itemId ?? attachment.projectId}`}
                        kind={attachment.kind}
                        label={attachment.label}
                        onRemove={isDraft ? () => {
                          setAttachments((current) => current.filter((item) => item.id !== attachment.id))
                          if (attachment.kind === "project" && attachment.projectId === newChatProjectId)
                            setNewChatProjectId(undefined)
                        } : undefined}
                      />
                    )
                  })}
                </ul>
              ) : (
                <p className="min-w-0 truncate text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Project</span>
                  <span aria-hidden="true"> · </span>
                  {contextProjectLabel}
                </p>
              )}
            </div>
          ) : null}
        </header>

        <section
          ref={conversationRef}
          onScroll={updateScrollToBottomVisibility}
          aria-label="Conversation"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto py-5"
        >
          {activeChat?.isArchived && (
            <div className="mx-auto mb-3 flex w-full max-w-2xl shrink-0 items-center justify-between gap-3 rounded-xl border border-border/80 bg-muted/60 px-4 py-2 text-xs text-muted-foreground">
              <div className="flex items-center gap-2">
                <HugeiconsIcon
                  icon={Archive02Icon}
                  size={15}
                  className="shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>
                  This chat is archived. Restore it to continue the
                  conversation.
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => toggleChatArchived(activeChat.id, false)}
              >
                Restore chat
              </Button>
            </div>
          )}
          {activeChatId && activeChat === undefined ? (
            <div
              className="m-auto flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
              Loading chat…
            </div>
          ) : activeChatId && activeChat === null ? (
            <div className="m-auto max-w-sm text-center">
              <h2 className="text-lg font-medium">Chat not found</h2>
              <Button variant="outline" className="mt-4" onClick={startNewChat}>
                Start a new chat
              </Button>
            </div>
          ) : !messages.length ? (
            <div className="m-auto max-w-xl px-4 py-12 text-center">
              <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
                <HugeiconsIcon icon={Chat01Icon} size={25} strokeWidth={1.8} />
              </span>
              <h2 className="mt-5 text-2xl font-medium tracking-tight">
                {contextualCard
                  ? `Ask about ${contextualCard.label}`
                  : contextualProject
                    ? `Ask about ${contextualProject.label}`
                    : "Ask Blitz"}
              </h2>
            </div>
          ) : (
            <div
              className="mx-auto flex w-full max-w-3xl flex-col gap-6"
              aria-live="polite"
            >
              {messages.map((message, index) => {
                const editing = editingMessageId === message.id
                const latest = index === messages.length - 1
                const actionPending = messageActionId === message.id
                const messageAnnotations: FloatingAnnotation[] = [
                  ...sentAnnotations
                    .filter((a) => a.messageId === message.id)
                    .map((a) => ({ ...a, isDraft: false })),
                  ...draftAnnotations
                    .filter((a) => a.messageId === message.id)
                    .map((a) => ({ ...a, isDraft: true })),
                ]
                const persistedProviderEvents =
                  "providerEvents" in message &&
                  Array.isArray(message.providerEvents)
                    ? (message.providerEvents as ProviderActivityEvent[])
                    : []
                const messageEvents =
                  message.status === "running" && streamProviderEvents.length
                    ? streamProviderEvents
                    : persistedProviderEvents
                const messageRequests =
                  "agentRequests" in message &&
                  Array.isArray(message.agentRequests)
                    ? message.agentRequests
                        .map((value) => agentRequestFromValue(value))
                        .filter(
                          (request): request is AgentRequest =>
                            request !== undefined &&
                            request.status !== "pending"
                        )
                    : []
                const messageAttachments =
                  message.role === "user"
                    ? persistedAttachments.filter((attachment) => {
                        if (
                          attachment.clientMessageId &&
                          userClientMessageIds.has(attachment.clientMessageId)
                        ) {
                          return (
                            attachment.clientMessageId ===
                            message.clientMessageId
                          )
                        }
                        const firstUserMessage = messages.find(
                          (m) => m.role === "user"
                        )
                        return firstUserMessage?.id === message.id
                      })
                    : []
                return (
                  <article
                    key={message.id}
                    className={cn(
                      "group text-sm leading-6",
                      message.role === "user"
                        ? "ml-auto flex max-w-[88%] flex-col items-end sm:max-w-[78%]"
                        : "mr-auto w-full min-w-0"
                    )}
                  >
                    {message.role === "user" && messageAttachments.length > 0 ? (
                      <ul
                        aria-label="Attached files and context"
                        className="mb-1.5 flex min-w-0 flex-wrap items-center justify-end gap-1.5"
                      >
                        {messageAttachments.map((attachment) => (
                          <AttachmentChip
                            key={attachment.id}
                            kind={attachment.kind}
                            label={attachment.label}
                            previewUrl={
                              attachment.documentId &&
                              attachment.mimeType?.startsWith("image/")
                                ? `/api/chat/files?documentId=${encodeURIComponent(attachment.documentId)}&${attachment.projectId ? `projectId=${encodeURIComponent(attachment.projectId)}` : `chatId=${encodeURIComponent(activeChatId ?? "")}`}`
                                : undefined
                            }
                            href={
                              attachment.documentId
                                ? `/api/chat/files?documentId=${encodeURIComponent(attachment.documentId)}&${attachment.projectId ? `projectId=${encodeURIComponent(attachment.projectId)}` : `chatId=${encodeURIComponent(activeChatId ?? "")}`}`
                                : attachment.url ?? undefined
                            }
                          />
                        ))}
                      </ul>
                    ) : null}
                    <div
                      className={cn(
                        message.role === "user" &&
                          "rounded-2xl rounded-br-md bg-brand px-4 py-3 text-brand-foreground",
                        editing && "w-full",
                        message.status === "failed" &&
                          message.role === "assistant" &&
                          "text-destructive"
                      )}
                    >
                      {message.role === "assistant" ? (
                        <>
                          <ThoughtTrace
                            thought={message.thought}
                            durationMs={message.durationMs}
                            status={message.status}
                            startedAt={message.createdAt}
                            events={messageEvents}
                            requests={messageRequests}
                          />
                          {message.content ? (
                            <AnnotatedAssistantMessage
                              messageId={message.id}
                              content={message.content}
                              citations={message.citations}
                              annotations={messageAnnotations}
                              allChatAnnotations={allChatAnnotations}
                              expandedAnnotationId={expandedAnnotationId}
                              isReadOnly={isRunning}
                              onToggleExpand={toggleExpandAnnotation}
                              onCitation={(citation) => {
                                if (!activeChatId) return
                                const selection: SourceSelection = {
                                    chatId: activeChatId,
                                    messageId: message.id,
                                    citationId: citation.id,
                                }
                                if (onOpenSource) onOpenSource(selection)
                                else setSourceSelection(selection)
                              }}
                              onAddAnnotation={(selectedText) =>
                                addAnnotation(message.id, selectedText)
                              }
                              onSaveAnnotation={saveAnnotation}
                              onDeleteAnnotation={deleteAnnotation}
                            />
                          ) : message.status === "failed" ? (
                            <p>
                              {activeChat?.lastError ||
                                "Blitz could not finish this reply."}
                            </p>
                          ) : null}
                        </>
                      ) : editing ? (
                        <div className="space-y-2">
                          <Textarea
                            aria-label="Edit message"
                            autoFocus
                            maxLength={4_000}
                            rows={3}
                            value={editDraft}
                            disabled={actionPending}
                            className="max-h-48 resize-y border-brand-foreground/20 bg-background text-foreground"
                            onChange={(event) =>
                              setEditDraft(event.target.value)
                            }
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-brand-foreground hover:bg-brand-foreground/15 hover:text-brand-foreground"
                              disabled={actionPending}
                              onClick={() => {
                                setEditingMessageId(undefined)
                                setEditDraft("")
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={!editDraft.trim() || actionPending}
                              onClick={() => void saveEditedMessage(message.id)}
                            >
                              {actionPending ? (
                                <LoadingIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                              ) : (
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  size={15}
                                  aria-hidden="true"
                                />
                              )}
                              Save and send
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div>
                          {message.content ? (
                            <Markdown text={message.content} />
                          ) : null}
                          {"annotations" in message &&
                          Array.isArray(message.annotations) &&
                          message.annotations.length ? (
                            <div
                              className={cn(
                                message.content
                                  ? "mt-1 flex justify-end"
                                  : "flex items-center"
                              )}
                            >
                              <UserMessageAnnotationsBadge
                                annotations={
                                  message.annotations as FloatingAnnotation[]
                                }
                              />
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>

                    {!editing ? (
                      <div className="mt-1 flex w-full items-center justify-between gap-2">
                        <div
                          className={cn(
                            "flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground",
                            message.role === "user" && "justify-end"
                          )}
                        >
                        {message.content ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                            onClick={() =>
                              void copyMessage(message.id, message.content)
                            }
                          >
                            <HugeiconsIcon
                              icon={Copy01Icon}
                              size={14}
                              aria-hidden="true"
                            />
                            {copiedMessageId === message.id ? "Copied" : "Copy"}
                          </Button>
                        ) : null}
                        {message.role === "user" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                            disabled={isRunning || Boolean(messageActionId)}
                            onClick={() =>
                              beginEditing(message.id, message.content)
                            }
                          >
                            <HugeiconsIcon
                              icon={PencilEdit02Icon}
                              size={14}
                              aria-hidden="true"
                            />
                            Edit
                          </Button>
                        ) : (
                          <>
                            {message.content ? (
                              <>
                                {message.status !== "running" ? (
                                  <ReadAloudButton
                                    text={message.content}
                                    prepare={latest}
                                  />
                                ) : null}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                                  disabled={
                                    isRunning || Boolean(messageActionId)
                                  }
                                  onClick={() =>
                                    void branchFromResponse(message.id)
                                  }
                                >
                                  {actionPending ? (
                                    <LoadingIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                                  ) : (
                                    <HugeiconsIcon
                                      icon={SplitIcon}
                                      size={14}
                                      className="rotate-90"
                                      aria-hidden="true"
                                    />
                                  )}
                                  Branch
                                </Button>
                              </>
                            ) : null}
                            {latest && message.status === "failed" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                                disabled={isRunning || Boolean(messageActionId)}
                                onClick={() =>
                                  void continueResponse(message.id)
                                }
                              >
                                {actionPending ? (
                                  <LoadingIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                                ) : (
                                  <HugeiconsIcon
                                    icon={PlayIcon}
                                    size={14}
                                    aria-hidden="true"
                                  />
                                )}
                                {message.content
                                  ? "Continue response"
                                  : "Retry response"}
                              </Button>
                            ) : null}
                          </>
                        )}
                        </div>
                        {typeof message.createdAt === "number" ? (
                          <time
                            dateTime={new Date(message.createdAt).toISOString()}
                            aria-label={`Sent at ${formatMessageTime(message.createdAt)}`}
                            className="shrink-0 select-none whitespace-nowrap text-right text-[11px] leading-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            {formatMessageTime(message.createdAt)}
                          </time>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                )
              })}
              <div ref={messageEndRef} />
            </div>
          )}
        </section>

        <div className="relative mx-auto w-full max-w-3xl shrink-0 pb-3">
          {messages.length > 0 && (showScrollToBottom || isStreaming) ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={isStreaming ? "Generating response" : "Scroll to latest message"}
              title={isStreaming ? "Generating response" : "Scroll to latest message"}
              disabled={isStreaming}
              onClick={scrollToLatestMessage}
              className="absolute -top-10 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full bg-background/95 shadow-sm backdrop-blur"
            >
              {isStreaming ? (
                <span className="flex items-center gap-0.5" aria-hidden="true">
                  <span className="size-1 animate-bounce rounded-full bg-current motion-reduce:animate-none" />
                  <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:120ms] motion-reduce:animate-none" />
                  <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:240ms] motion-reduce:animate-none" />
                </span>
              ) : (
                <HugeiconsIcon icon={ArrowDown01Icon} size={16} aria-hidden="true" />
              )}
            </Button>
          ) : null}
          {composerAttachments.length ||
          draftAnnotations.length ? (
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 px-1">
              <ul
                aria-label="Attached context"
                className="flex min-w-0 flex-wrap items-center gap-1.5"
              >
                {hasOrphanPersistedAttachments
                  ? persistedAttachments
                      .filter(
                        (attachment) =>
                          attachment.kind !== "card" &&
                          attachment.kind !== "project"
                      )
                      .map((attachment) => (
                      <AttachmentChip
                        key={attachment.id}
                        kind={attachment.kind}
                        label={attachment.label}
                        previewUrl={
                          attachment.documentId &&
                          attachment.mimeType?.startsWith("image/")
                            ? `/api/chat/files?documentId=${encodeURIComponent(attachment.documentId)}&${attachment.projectId ? `projectId=${encodeURIComponent(attachment.projectId)}` : `chatId=${encodeURIComponent(activeChatId ?? "")}`}`
                            : undefined
                        }
                        href={
                          attachment.documentId
                            ? `/api/chat/files?documentId=${encodeURIComponent(attachment.documentId)}&${attachment.projectId ? `projectId=${encodeURIComponent(attachment.projectId)}` : `chatId=${encodeURIComponent(activeChatId ?? "")}`}`
                            : attachment.url ?? undefined
                        }
                      />
                    ))
                  : null}
                {attachments
                  .filter(
                    (attachment) =>
                      attachment.kind !== "card" &&
                      attachment.kind !== "project"
                  )
                  .map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    kind={attachment.kind}
                    label={attachment.label}
                    previewUrl={attachment.previewUrl}
                    onRemove={() => {
                      if (attachment.previewUrl)
                        URL.revokeObjectURL(attachment.previewUrl)
                      setAttachments((current) =>
                        current.filter((item) => item.id !== attachment.id)
                      )
                      if (
                        attachment.kind === "project" &&
                        attachment.projectId === newChatProjectId
                      ) {
                        setNewChatProjectId(undefined)
                      }
                    }}
                  />
                ))}
                {draftAnnotations.length ? (
                  <AnnotationAttachmentChip
                    annotations={draftAnnotations}
                    onSelect={(id) => setExpandedAnnotationId(id)}
                    onRemove={() => {
                      setDraftAnnotations([])
                      setExpandedAnnotationId(undefined)
                    }}
                  />
                ) : null}
              </ul>
            </div>
          ) : null}
          {visibleComposerRequest ? (
            <AgentRequestPanel
              key={visibleComposerRequest.request.id}
              request={visibleComposerRequest.request}
              busy={approvalBusy === visibleComposerRequest.request.id}
              onSubmit={(submission) => {
                void decideAgentRequest(
                  visibleComposerRequest.request,
                  visibleComposerRequest.messageId,
                  submission
                )
              }}
            />
          ) : null}
          {queuedMessage ? (
            <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-border/80 bg-muted/40 px-3 py-1.5 text-xs">
              <div className="flex min-w-0 items-center gap-1.5">
                <HugeiconsIcon
                  icon={SendIcon}
                  size={13}
                  className="shrink-0 text-brand"
                  aria-hidden="true"
                />
                <span className="shrink-0 font-medium text-muted-foreground">
                  Queued:
                </span>
                <span className="truncate text-foreground">
                  {queuedMessage.message ||
                    (queuedMessage.attachments.length
                      ? `${queuedMessage.attachments.length} attachment(s)`
                      : "Queued message")}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-destructive"
                onClick={deleteQueuedMessage}
                aria-label="Delete queued message"
              >
                <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={2} />
                Delete
              </Button>
            </div>
          ) : null}
          {continuableMessage ? (
            <div className="mb-2 flex items-center justify-between rounded-xl border border-border/80 bg-muted/40 px-3 py-1.5 text-xs">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <HugeiconsIcon
                  icon={PlayIcon}
                  size={13}
                  className="shrink-0 text-brand"
                  aria-hidden="true"
                />
                <span>Continuing paused response</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
                onClick={() => setDismissedContinuationId(continuableMessage.id)}
              >
                Ask new question instead
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "rounded-[24px] border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40",
              draggingFiles && "border-brand bg-brand/5 ring-2 ring-brand/30"
            )}
          >
            {/* File drops bubble to the chat pane's single drop handler. */}
            <Textarea
              aria-label="Message Blitz"
              value={draft}
              maxLength={4_000}
              rows={2}
              disabled={
                uploadingFiles ||
                importingLink ||
                savingReplySettings ||
                Boolean(messageActionId)
              }
              placeholder={
                isStreaming
                  ? isMac
                    ? "Press Enter to queue, ⌘Enter to steer"
                    : "Press Enter to queue, Ctrl+Enter to steer"
                  : continuableMessage
                    ? "Add notes before continuing, or press Play to resume"
                    : "Ask Blitz…"
              }
              className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <Input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  multiple
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) =>
                    void chooseFiles(Array.from(event.target.files ?? []))
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="rounded-full"
                  disabled={isRunning || Boolean(continuableMessage)}
                  aria-label="Upload file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon
                    icon={PlusIcon}
                    size={19}
                    strokeWidth={1.8}
                  />
                </Button>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 shrink-0 rounded-full px-3 text-xs"
                      disabled={Boolean(continuableMessage)}
                    >
                      Options
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="top"
                    align="start"
                    className="max-h-[min(70svh,32rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl p-4"
                  >
                    <div className="space-y-4">
                      <section className="space-y-2">
                        <h2 className="text-sm font-medium">Reply model</h2>
                        {/* Settings are read when a turn starts, so changes made
                            during a reply apply to the next message. */}
                        <ReplyModelPicker
                          disabled={Boolean(continuableMessage)}
                          onSaveStateChange={setSavingReplySettings}
                        />
                      </section>
                      <section className="space-y-2 border-t pt-3">
                        <h2 className="text-sm font-medium">Working project</h2>
                        <ChatAgentControls
                          autonomy={effectiveAgentAutonomy}
                          additionalInstructions={effectiveAgentInstructions}
                          workingProjectId={effectiveWorkingProjectId}
                          projects={projects}
                          disabled={Boolean(continuableMessage)}
                          onAutonomyChange={(value) => {
                            setAgentSettingsTouched(true)
                            setAgentAutonomy(value)
                            writeCachedAgentAutonomy(value)
                          }}
                          onInstructionsChange={(value) => {
                            setAgentSettingsTouched(true)
                            setAgentInstructions(value)
                          }}
                          onWorkingProjectChange={(value) => {
                            setAgentSettingsTouched(true)
                            setWorkingProjectId(value)
                          }}
                        />
                      </section>
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              {(() => {
                if (isStreaming) {
                  const hasDraft = Boolean(
                    draft.trim() ||
                      attachments.length > 0 ||
                      draftAnnotations.some((a) => a.note.trim().length > 0)
                  )
                  if (!hasDraft) {
                    return (
                      <Button
                        type="button"
                        size="icon"
                        aria-label="Pause response"
                        className="ml-auto shrink-0 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                        disabled={Boolean(messageActionId)}
                        onClick={pauseReply}
                      >
                        <HugeiconsIcon
                          icon={PauseIcon}
                          size={18}
                          strokeWidth={2}
                        />
                      </Button>
                    )
                  }
                  return (
                    <div className="ml-auto flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1 rounded-full text-xs font-medium"
                        disabled={Boolean(messageActionId)}
                        onClick={() => void hotSteerReply()}
                        aria-label="Steer response"
                      >
                        <HugeiconsIcon
                          icon={PlayIcon}
                          size={14}
                          strokeWidth={2}
                        />
                        Steer
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        className="h-8 w-8 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                        disabled={Boolean(messageActionId)}
                        onClick={queueDraftMessage}
                        aria-label="Queue message"
                      >
                        <HugeiconsIcon
                          icon={SendIcon}
                          size={16}
                          strokeWidth={2}
                        />
                      </Button>
                    </div>
                  )
                }
                if (continuableMessage) {
                  const hasDraft = Boolean(draft.trim())
                  return (
                    <Button
                      type="button"
                      size="icon"
                      aria-label={
                        hasDraft ? "Steer response" : "Resume response"
                      }
                      className="ml-auto shrink-0 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                      disabled={Boolean(messageActionId) || isRunning}
                      onClick={() =>
                        void continueResponse(
                          continuableMessage.id,
                          hasDraft ? draft.trim() : undefined
                        )
                      }
                    >
                      <HugeiconsIcon
                        icon={PlayIcon}
                        size={18}
                        strokeWidth={2}
                      />
                    </Button>
                  )
                }
                return (
                  <Button
                    type="button"
                    size="icon"
                    aria-label="Send message"
                    className="ml-auto shrink-0 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                    disabled={
                      (!draft.trim() && !draftAnnotations.length) || isRunning
                    }
                    onClick={() => void sendMessage()}
                  >
                    <HugeiconsIcon
                      icon={SendIcon}
                      size={18}
                      strokeWidth={2}
                    />
                  </Button>
                )
              })()}
            </div>
          </div>
          <div className="min-h-6 px-3 pt-1.5">
            {uploadingFiles ? (
              <p role="status" className="text-xs text-muted-foreground">
                Saving and reading files…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-center text-[11px] text-muted-foreground">
                Blitz can make mistakes. Check important details against your
                sources.
              </p>
            )}
          </div>
        </div>
      </div>

      {!embedded && sourceSelection ? (
        <SourcePane
          key={`${sourceSelection.messageId}:${sourceSelection.citationId}`}
          selection={sourceSelection}
          onClose={() => setSourceSelection(undefined)}
        />
      ) : null}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="h-[min(680px,calc(100svh-2rem))] min-w-0 overflow-hidden p-0 sm:max-w-sm"
          showCloseButton={false}
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Chat history</DialogTitle>
          {history}
        </DialogContent>
      </Dialog>

      <NewChatDialog
        open={newChatDialogOpen}
        projects={projects}
        onOpenChange={setNewChatDialogOpen}
        onSelect={startNewChatForProject}
        onCreate={createNewChatProject}
      />

      <Dialog
        open={renameChatId !== undefined}
        onOpenChange={(open) => {
          if (!open && !chatActionPending) {
            setRenameChatId(undefined)
            setChatActionError("")
          }
        }}
      >
        <DialogContent
          aria-describedby="rename-chat-description"
          showCloseButton={!chatActionPending}
        >
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription id="rename-chat-description">
              Choose a name that will be easy to find later.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void saveChatName()
            }}
          >
            <div className="grid gap-2">
              <label htmlFor="rename-chat" className="font-medium">
                Chat name
              </label>
              <Input
                id="rename-chat"
                autoFocus
                maxLength={64}
                value={renameDraft}
                disabled={chatActionPending}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
            </div>
            {chatActionError ? (
              <p role="alert" className="text-sm text-destructive">
                {chatActionError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={chatActionPending}
                onClick={() => setRenameChatId(undefined)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11"
                disabled={
                  chatActionPending ||
                  !renameDraft.trim() ||
                  renameDraft.trim() === renameTarget?.title
                }
              >
                {chatActionPending ? "Saving…" : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent aria-describedby="export-chat-description">
          <DialogHeader>
            <DialogTitle>Export chat</DialogTitle>
            <DialogDescription id="export-chat-description">
              Export the full conversation as Markdown, including your messages and replies.
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
            <Checkbox
              checked={includeAgentActivity}
              onCheckedChange={(checked) => setIncludeAgentActivity(checked === true)}
              className="mt-0.5"
            />
            <span className="grid gap-1">
              <span className="font-medium">Include agent working and tool calls</span>
              <span className="text-muted-foreground">Adds available working notes, tool activity, and agent requests.</span>
            </span>
          </label>
          <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{exportNotice}</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => void copyExport()}>
              <HugeiconsIcon icon={Copy01Icon} size={15} aria-hidden="true" />
              Copy to clipboard
            </Button>
            <Button type="button" onClick={downloadExport}>
              <HugeiconsIcon icon={Download01Icon} size={15} aria-hidden="true" />
              Export as Markdown
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ArchivedChatsDialog
        open={archivedDialogOpen}
        archivedChats={archivedChats}
        onOpenChange={setArchivedDialogOpen}
        onSelect={(id) => {
          selectChat(id)
          setArchivedDialogOpen(false)
        }}
        onUnarchive={(id) => toggleChatArchived(id, false)}
        onDelete={(id) => setDeleteChatId(id)}
      />

      <Dialog
        open={deleteChatId !== undefined}
        onOpenChange={(open) => {
          if (!open && !deletingChat) setDeleteChatId(undefined)
        }}
      >
        <DialogContent
          aria-describedby="delete-chat-description"
          showCloseButton={!deletingChat}
        >
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription id="delete-chat-description">
              {deleteTarget
                ? `This permanently deletes “${deleteTarget.title}” and its messages. This cannot be undone.`
                : "This permanently deletes this chat and its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={deletingChat}
              onClick={() => setDeleteChatId(undefined)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={deletingChat}
              onClick={() => void confirmDeleteChat()}
            >
              {deletingChat ? "Deleting…" : "Delete chat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent aria-describedby="project-chat-description">
          <DialogHeader>
            <DialogTitle>Attach a project</DialogTitle>
            <DialogDescription id="project-chat-description">
              Blitz will read up to eight ready sources from the project.
            </DialogDescription>
          </DialogHeader>
          <div className="-mx-1 max-h-72 space-y-1 overflow-y-auto p-1">
            {projects === undefined ? (
              <p role="status" className="p-4 text-sm text-muted-foreground">
                Loading projects…
              </p>
            ) : projects.length ? (
              projects.map((project) => {
                const attached = attachments.some(
                  (attachment) => attachment.projectId === project._id
                )
                return (
                  <Button
                    key={project._id}
                    type="button"
                    variant="ghost"
                    disabled={attached || !canAttachProject}
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                    onClick={() => {
                      addAttachment({
                        id: crypto.randomUUID(),
                        kind: "project",
                        label: project.title,
                        projectId: project._id,
                      })
                      setProjectDialogOpen(false)
                    }}
                  >
                    <HugeiconsIcon icon={Folder01Icon} size={18} />
                    <span className="min-w-0 flex-1 truncate">
                      {project.title}
                    </span>
                    {attached ? (
                      <span className="text-xs text-muted-foreground">
                        Attached
                      </span>
                    ) : null}
                  </Button>
                )
              })
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                Create a project in Library, then attach it here.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent aria-describedby="link-chat-description">
          <DialogHeader>
            <DialogTitle>Attach a public link</DialogTitle>
            <DialogDescription id="link-chat-description">
              Add a public webpage, PDF, text file, or PowerPoint link.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void attachLink()
            }}
          >
            <Input
              type="url"
              autoFocus
              required
              maxLength={2_048}
              disabled={importingLink}
              placeholder="https://example.com/notes.pdf"
              value={linkUrl}
              onChange={(event) => setLinkUrl(event.target.value)}
            />
            <Button
              type="submit"
              className="w-full bg-brand text-brand-foreground hover:bg-brand/85"
              disabled={!linkUrl.trim() || importingLink}
            >
              {importingLink ? (
                <>
                  <LoadingIcon className="animate-spin motion-reduce:animate-none" />
                  Reading link…
                </>
              ) : (
                <>
                  <SparklesIcon /> Attach link
                </>
              )}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** Renders one persisted or removable attachment with hover-revealed removal controls. */
function AttachmentChip({
  kind,
  label,
  previewUrl,
  href,
  onRemove,
}: {
  kind: "card" | "project" | "file" | "link"
  label: string
  previewUrl?: string
  href?: string
  onRemove?: () => void
}) {
  const content = (
    <>
      {previewUrl ? (
        <Image
          src={previewUrl}
          alt=""
          width={20}
          height={20}
          unoptimized
          className="size-5 shrink-0 rounded object-cover"
        />
      ) : (
        <HugeiconsIcon
          icon={
            kind === "card"
              ? BookTextIcon
              : kind === "project"
                ? Folder01Icon
                : kind === "link"
                  ? Link02Icon
                  : File01Icon
          }
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <span className="max-w-52 truncate">{label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="pointer-events-none absolute top-1/2 right-1 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-secondary text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:border-border hover:bg-card hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <CancelIcon className="size-3" />
        </button>
      ) : null}
    </>
  )

  const chipClassName =
    "group relative flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 text-xs text-foreground backdrop-blur-xs transition-colors hover:border-border hover:bg-muted/60"

  if (href && !onRemove) {
    return (
      <li>
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={cn(
            chipClassName,
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          {content}
        </a>
      </li>
    )
  }

  return <li className={chipClassName}>{content}</li>
}

/**
 * Renders a composer attachment chip showing the number of draft annotations.
 *
 * Clicking the chip opens a popover listing all draft annotations with quotes and notes,
 * allowing the user to select one to jump/expand its edit card on the reply, or clear them all.
 *
 * @param annotations - Array of active draft annotations attached to the current composer turn.
 * @param onSelect - Callback when an annotation in the popover list is clicked to focus or expand it.
 * @param onRemove - Callback to remove/clear all draft annotations.
 */
function AnnotationAttachmentChip({
  annotations,
  onSelect,
  onRemove,
}: {
  annotations: FloatingAnnotation[]
  onSelect?: (id: string) => void
  onRemove?: () => void
}) {
  const [open, setOpen] = useState(false)
  const count = annotations.length
  const label = `${count} ${count === 1 ? "annotation" : "annotations"}`

  return (
    <li className="group relative flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-brand/40 bg-brand/10 px-2.5 text-xs text-foreground backdrop-blur-xs transition-colors hover:border-brand/60 hover:bg-brand/15">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs font-medium text-brand outline-none hover:underline"
          >
            <HugeiconsIcon
              icon={QuoteUpIcon}
              size={14}
              strokeWidth={1.8}
              className="shrink-0 text-brand"
              aria-hidden="true"
            />
            <span className="truncate">{label}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="max-h-72 w-80 space-y-2.5 overflow-y-auto p-3 text-xs"
        >
          <div className="flex items-center justify-between border-b border-border/50 pb-1 font-medium text-muted-foreground">
            <span>{label}</span>
            {onRemove ? (
              <button
                type="button"
                className="text-[11px] text-destructive hover:underline"
                onClick={() => {
                  setOpen(false)
                  onRemove()
                }}
              >
                Clear all
              </button>
            ) : null}
          </div>
          <div className="space-y-2">
            {annotations.map((ann, idx) => {
              const num = ann.number ?? idx + 1
              return (
                <div
                  key={ann.id}
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer rounded-lg border border-border/60 bg-muted/40 p-2 text-left transition-colors hover:border-border hover:bg-muted/80"
                  onClick={() => {
                    onSelect?.(ann.id)
                    setOpen(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      onSelect?.(ann.id)
                      setOpen(false)
                    }
                  }}
                >
                  <div className="flex items-center gap-1.5 font-medium text-brand">
                    <span className="rounded bg-brand/20 px-1 py-0.5 text-[10px] font-bold">
                      [{num}]
                    </span>
                    <span className="truncate font-normal text-foreground/80 italic">
                      &ldquo;{ann.selectedText}&rdquo;
                    </span>
                  </div>
                  {ann.note ? (
                    <p className="mt-1 line-clamp-2 text-foreground/90">
                      {ann.note}
                    </p>
                  ) : (
                    <p className="mt-1 text-muted-foreground italic">
                      No note added
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </PopoverContent>
      </Popover>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          className="pointer-events-none absolute top-1/2 right-1 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-border/70 bg-secondary text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:border-border hover:bg-card hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(pointer:coarse)]:pointer-events-auto [@media(pointer:coarse)]:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          <CancelIcon className="size-3" />
        </button>
      ) : null}
    </li>
  )
}

/**
 * Renders a read-only badge on sent user messages showing attached annotations in an interactive popover.
 *
 * Once a turn is submitted, annotations become strictly read-only. This badge informs the reader that
 * annotations were included with the message and allows reviewing the quoted text and attached notes.
 *
 * @param annotations - Array of persisted read-only annotations attached to the user message.
 */
function UserMessageAnnotationsBadge({
  annotations,
}: {
  annotations: FloatingAnnotation[]
}) {
  const count = annotations.length
  if (!count) return null
  const label = `${count} ${count === 1 ? "annotation" : "annotations"}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`View ${label}`}
          className="inline-flex items-center gap-1 rounded-full border border-brand-foreground/30 bg-brand-foreground/10 px-2 py-0.5 text-[11px] font-medium text-brand-foreground transition-colors hover:bg-brand-foreground/20"
        >
          <HugeiconsIcon
            icon={QuoteUpIcon}
            size={12}
            strokeWidth={2}
            className="shrink-0 text-brand-foreground/90"
            aria-hidden="true"
          />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="max-h-72 w-80 space-y-2 overflow-y-auto p-3 text-xs text-foreground"
      >
        <div className="border-b border-border/50 pb-1 font-medium text-muted-foreground">
          Attached {label}
        </div>
        <div className="space-y-2">
          {annotations.map((ann, idx) => {
            const num = ann.number ?? idx + 1
            return (
              <div
                key={ann.id}
                className="rounded-lg border border-border/60 bg-muted/40 p-2 text-left"
              >
                <div className="flex items-center gap-1.5 font-medium text-brand">
                  <span className="rounded bg-brand/20 px-1 py-0.5 text-[10px] font-bold">
                    [{num}]
                  </span>
                  <span className="truncate font-normal text-foreground/80 italic">
                    &ldquo;{ann.selectedText}&rdquo;
                  </span>
                </div>
                {ann.note ? (
                  <p className="mt-1 whitespace-pre-wrap text-foreground/90">
                    {ann.note}
                  </p>
                ) : (
                  <p className="mt-1 text-muted-foreground italic">
                    No note added
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
