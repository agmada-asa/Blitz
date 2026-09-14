"use client"

/** Owns persisted Blitz chat selection, streaming, and mixed-context attachments. */

import {
  Archive02Icon,
  BookTextIcon,
  Chat01Icon,
  CheckUnread01Icon,
  Copy01Icon,
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
  useRef,
  useState,
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
import { ProviderActivity } from "@/components/chat/provider-activity"
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
import { SourcePane } from "@/components/chat/source-pane"
import { ThoughtTrace } from "@/components/chat/thought-trace"
import { Textarea } from "@/components/ui/textarea"
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
  limitComposerFiles,
} from "@/lib/client/chat-composer-input"

/** Maximum context items accepted with one message. */
const MAX_ATTACHMENTS = 8
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
}

/** Optional overrides for standard, edited, and continued chat submissions. */
type SendMessageOptions = {
  message?: string
  chatId?: Id<"workspaceChats">
  continuationOf?: Id<"workspaceChatMessages">
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
  }
}

/** Builds deterministic local requests for exercising every composer request control. */
function createRequestUiFixtureRequests(): AgentRequest[] {
  const expiresAt = Date.now() + 5 * 60 * 1_000
  return [
    {
      id: "request-ui-fixture-approval",
      method: "item/commandExecution/requestApproval",
      kind: "approval",
      title: "Request UI test: allow a harmless command",
      prompt: "This local fixture simulates a runtime approval request.",
      details: JSON.stringify(
        {
          command: "printf 'request UI test\\n'",
          cwd: "/tmp",
          risk: "No files are changed.",
        },
        null,
        2
      ),
      expiresAt,
      status: "pending",
    },
    {
      id: "request-ui-fixture-question",
      method: "item/tool/requestUserInput",
      kind: "question",
      title: "Request UI test: choose an option",
      prompt: "This local fixture simulates a structured agent question.",
      details: JSON.stringify({ source: "local request UI fixture" }, null, 2),
      input: JSON.stringify({
        questions: [
          {
            id: "study-mode",
            header: "Study mode",
            question: "Which mode should Blitz use for this test?",
            options: [
              {
                value: "quick",
                label: "Quick review",
                description: "Keep the response short and focused.",
              },
              {
                value: "deep",
                label: "Deep review",
                description: "Include more explanation and context.",
              },
            ],
            isOther: true,
          },
        ],
      }),
      expiresAt,
      status: "pending",
    },
    {
      id: "request-ui-fixture-form",
      method: "mcpServer/elicitation/request",
      kind: "form",
      title: "Request UI test: fill in a form",
      prompt: "This local fixture simulates an MCP form elicitation.",
      details: JSON.stringify(
        { serverName: "Local request fixture", mode: "form" },
        null,
        2
      ),
      input: JSON.stringify({
        serverName: "Local request fixture",
        message: "Provide a few values to continue.",
        fields: [
          {
            id: "topic",
            label: "Topic",
            type: "text",
            required: true,
            description: "A required text field.",
          },
          {
            id: "count",
            label: "Number of cards",
            type: "integer",
            required: true,
            defaultValue: 3,
          },
          {
            id: "format",
            label: "Format",
            type: "single-select",
            required: true,
            options: [
              { value: "cards", label: "Study cards" },
              { value: "outline", label: "Outline" },
            ],
          },
          {
            id: "include-sources",
            label: "Include source links",
            type: "boolean",
            defaultValue: true,
          },
        ],
      }),
      expiresAt,
      status: "pending",
    },
    {
      id: "request-ui-fixture-url",
      method: "mcpServer/elicitation/request",
      kind: "url",
      title: "Request UI test: open a requested page",
      prompt: "This local fixture simulates an MCP URL handoff.",
      details: JSON.stringify(
        { serverName: "Local request fixture", mode: "url" },
        null,
        2
      ),
      input: JSON.stringify({
        serverName: "Local request fixture",
        message: "Open the page, then return here when you are finished.",
        url: "https://example.com/request-ui-test",
      }),
      expiresAt,
      status: "pending",
    },
  ]
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

/** Displays saved chat history beside the active conversation and composer. */
export function ChatWorkspace({
  initialChatId,
  initialCard,
  initialPrompt,
  initialProject,
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
  const requestControllerRef = useRef<AbortController | undefined>(undefined)
  const pausedByUserRef = useRef(false)
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
  const [requestFixtureRequests, setRequestFixtureRequests] = useState<
    AgentRequest[]
  >([])
  const [requestFixtureStep, setRequestFixtureStep] = useState<number>()
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
  const messages = activeChat?.messages ?? []
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
  const isRunning =
    uploadingFiles ||
    importingLink ||
    sending ||
    activeChat?.status === "running" ||
    savingReplySettings ||
    Boolean(messageActionId) ||
    requestFixtureStep !== undefined
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
  const requestFixtureRequest =
    requestFixtureStep === undefined
      ? undefined
      : requestFixtureRequests[requestFixtureStep]
  const visibleComposerRequest = requestFixtureRequest
    ? { request: requestFixtureRequest, messageId: "request-ui-fixture" }
    : activeChatId
      ? composerAgentRequestEntry
      : undefined
  const canAttach = attachments.length < MAX_ATTACHMENTS
  const canAttachProject =
    canAttach &&
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
  const welcomeProjectId =
    selectedCard?.projectId ??
    selectedProject?.projectId ??
    activeChat?.projectId ??
    newChatProjectId
  const welcomeProject = projects?.find(
    (project) => project._id === welcomeProjectId
  )
  const welcomeProjectLabel =
    welcomeProject?.title ??
    (selectedProject && selectedProject.projectId === welcomeProjectId
      ? selectedProject.label
      : undefined)

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" })
  }, [messages.length, lastMessageContent])

  /** Opens the chat addressed by navigation links without remounting the workspace. */
  /** Clears a manual unread marker whenever a saved chat becomes active. */
  useEffect(() => {
    if (!activeChatId || activeChat?.id !== activeChatId) return
    void setChatUnread({ chatId: activeChatId, unread: false }).catch(
      (cause) => {
        setError(
          messageForError(cause, "This chat could not be marked as read.")
        )
      }
    )
  }, [activeChat?.id, activeChatId, setChatUnread])

  /** Starts the development-only sequence that exercises each composer request mode. */
  const startRequestUiFixture = (): void => {
    setError("")
    setRequestFixtureRequests(createRequestUiFixtureRequests())
    setRequestFixtureStep(0)
  }

  /** Advances the local request fixture after a simulated approval or denial. */
  const resolveRequestUiFixture = (): void => {
    setRequestFixtureStep((current) => {
      if (current === undefined || current + 1 >= requestFixtureRequests.length)
        return undefined
      return current + 1
    })
  }

  /** Selects one saved chat and mirrors it in the address bar. */
  const selectChat = (chatId: Id<"workspaceChats">): void => {
    setSourceSelection(undefined)
    setActiveChatId(chatId)
    revokeDraftPreviews()
    setAttachments([])
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setStreamAgentRequests({})
    setStreamProviderEvents([])
    setRequestFixtureStep(undefined)
    setAgentAutonomy(undefined)
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
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
    revokeDraftPreviews()
    setAttachments([])
    setDraft("")
    setDraftAnnotations([])
    setExpandedAnnotationId(undefined)
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setAgentAutonomy(readCachedAgentAutonomy())
    setAgentInstructions("")
    setWorkingProjectId(undefined)
    setNewChatProjectId(undefined)
    setStreamAgentRequests({})
    setStreamProviderEvents([])
    setRequestFixtureStep(undefined)
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    setNewChatDialogOpen(false)
    window.history.replaceState(null, "", "/chat")
  }

  /** Clears the composer and assigns the selected project to the pending chat. */
  const startNewChatForProject = (project: NewChatProject): void => {
    setSourceSelection(undefined)
    setActiveChatId(undefined)
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
    setRequestFixtureStep(undefined)
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    setNewChatDialogOpen(false)
    window.history.replaceState(
      null,
      "",
      `/chat?projectId=${encodeURIComponent(project._id)}`
    )
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
      if (current.length >= MAX_ATTACHMENTS) return current
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
    if (uploadingFiles) return
    setUploadingFiles(true)
    setError("")
    const selected = limitComposerFiles(
      files,
      MAX_ATTACHMENTS - attachments.length
    )
    const uploadProjectId = activeChat?.projectId ?? newChatProjectId ?? selectedProject?.projectId
    for (const file of selected) {
      try {
        if (file.size > 50_000_000)
          throw new Error("Chat files must be under 50 MB.")
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
    setUploadingFiles(false)
  }

  /** Handles files dropped onto the composer while preserving ordinary text drops. */
  const handleComposerDrop = (event: DragEvent<HTMLDivElement>): void => {
    const files = droppedFiles(Array.from(event.dataTransfer.files))
    if (!files.length) return
    event.preventDefault()
    setDraggingFiles(false)
    if (!isRunning && canAttach) void chooseFiles(files)
  }

  /** Handles clipboard screenshots without changing ordinary multiline text paste. */
  const handleComposerPaste = (
    event: ClipboardEvent<HTMLTextAreaElement>
  ): void => {
    const files = Array.from(event.clipboardData.files)
    if (!files.length || isRunning || !canAttach) return
    const images = clipboardImageFiles(files)
    if (!images.length) return
    event.preventDefault()
    void chooseFiles(images)
  }

  /** Fetches a public source through the protected route and attaches extracted text. */
  const attachLink = async (): Promise<void> => {
    const url = linkUrl.trim()
    if (!url || importingLink || !canAttach) return
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
    const submittedAnnotations =
      options.message === undefined && !options.continuationOf
        ? draftAnnotations.filter((a) => a.note.trim().length > 0)
        : []
    const rawMessage = (options.message ?? draft).trim()
    const message = rawMessage
    const targetChatId = options.chatId ?? activeChatId
    const targetProjectId = targetChatId ? undefined : newChatProjectId
    if (
      (!message && !submittedAnnotations.length && !options.continuationOf) ||
      sending ||
      uploadingFiles ||
      importingLink ||
      savingReplySettings ||
      (!options.chatId && activeChat?.status === "running") ||
      (options.continuationOf && !targetChatId)
    )
      return false
    const submittedAttachments =
      options.message === undefined && !options.continuationOf
        ? attachments
        : []
    const cardAttachment = submittedAttachments.find(
      (attachment) =>
        attachment.kind === "card" && attachment.projectId && attachment.itemId
    )
    if (!options.continuationOf) {
      setDraft("")
      setDraftAnnotations([])
      setExpandedAnnotationId(undefined)
    }
    setError("")
    setStreamProviderEvents([])
    setSending(true)
    pausedByUserRef.current = false
    const controller = new AbortController()
    requestControllerRef.current = controller
    let started = false
    let completed = false
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
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "started") {
          started = true
          revokeDraftPreviews()
          setAttachments([])
          setDraftAnnotations([])
          setExpandedAnnotationId(undefined)
          selectChat(event.chatId)
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
    } catch (sendError) {
      const paused = controller.signal.aborted && pausedByUserRef.current
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
      }
    } finally {
      if (requestControllerRef.current === controller)
        requestControllerRef.current = undefined
      pausedByUserRef.current = false
      setSending(false)
    }
    return completed
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
          throw new Error("This reply could not be paused. Its provider session may have ended; reload the chat to check its status.")
        requestControllerRef.current?.abort()
      })
      .catch((pauseError: unknown) => {
        pausedByUserRef.current = false
        setError(messageForError(pauseError, "The reply could not be paused. Try again."))
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

  /** Resumes the latest interrupted response in the same assistant message. */
  const continueResponse = async (
    messageId: Id<"workspaceChatMessages">
  ): Promise<void> => {
    if (!activeChatId || isRunning || messageActionId) return
    setMessageActionId(messageId)
    try {
      await sendMessage({ chatId: activeChatId, continuationOf: messageId })
    } finally {
      setMessageActionId(undefined)
    }
  }

  /** Sends on Enter while keeping Shift+Enter available for a new line. */
  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
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
    <main className="flex h-[calc(100svh-68px-env(safe-area-inset-bottom))] min-h-0 w-full overflow-hidden md:h-svh md:min-h-0">
      <aside
        className={cn(
          "hidden w-[276px] shrink-0 border-r border-border/70 bg-card/40 md:block",
          sourceSelection && "md:hidden"
        )}
      >
        {history}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col px-4 sm:px-8">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full md:hidden"
              aria-label="Open chat history"
              onClick={() => setHistoryOpen(true)}
            >
              <HugeiconsIcon icon={Menu01Icon} size={18} strokeWidth={1.8} />
            </Button>
            <h1 className="truncate text-xl font-medium tracking-tight">
              {activeChat?.title ?? "New chat"}
            </h1>
            {activeChat && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
                    aria-label={`Actions for ${activeChat.title}`}
                  >
                    <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem
                    onSelect={() => openRenameChat(activeChat.id)}
                  >
                    <HugeiconsIcon
                      icon={PencilEdit02Icon}
                      size={15}
                      aria-hidden="true"
                    />
                    Rename chat
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => toggleChatUnread(activeChat.id, true)}
                  >
                    <HugeiconsIcon
                      icon={CheckUnread01Icon}
                      size={15}
                      aria-hidden="true"
                    />
                    Mark as unread
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      toggleChatPinned(
                        activeChat.id,
                        !activeChatTarget?.isPinned
                      )
                    }
                  >
                    <HugeiconsIcon
                      icon={Pin02Icon}
                      size={15}
                      aria-hidden="true"
                    />
                    {activeChatTarget?.isPinned ? "Unpin chat" : "Pin chat"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      toggleChatArchived(activeChat.id, !activeChat.isArchived)
                    }
                  >
                    <HugeiconsIcon
                      icon={Archive02Icon}
                      size={15}
                      aria-hidden="true"
                    />
                    {activeChat.isArchived ? "Restore chat" : "Archive chat"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => setDeleteChatId(activeChat.id)}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={15}
                      aria-hidden="true"
                    />
                    Delete chat
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-full md:hidden"
            disabled={isRunning}
            onClick={startNewChat}
          >
            New chat
          </Button>
        </header>

        <section
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
                {selectedCard?.itemId ? (
                  <>
                    Ask about {selectedCard.label}
                    {welcomeProjectId && welcomeProjectLabel ? (
                      <>
                        {" "}
                        in{" "}
                        <Link
                          href={`/projects/${encodeURIComponent(welcomeProjectId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {welcomeProjectLabel}
                        </Link>
                      </>
                    ) : null}
                  </>
                ) : selectedProject?.projectId ? (
                  <>
                    Ask about{" "}
                    <Link
                      href={`/projects/${encodeURIComponent(selectedProject.projectId)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {selectedProject.label}
                    </Link>
                  </>
                ) : (
                  "Ask about anything"
                )}
              </h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                Attach a project, PDF, notes, PowerPoint, or public link. Blitz
                will use that material as context for the conversation.
              </p>
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
                return (
                  <article
                    key={message.id}
                    className={cn(
                      "max-w-[88%] text-sm leading-6 sm:max-w-[78%]",
                      message.role === "user" ? "ml-auto" : "mr-auto min-w-0"
                    )}
                  >
                    <div
                      className={cn(
                        message.role === "user" &&
                          "rounded-2xl rounded-br-md bg-brand px-4 py-3 text-brand-foreground",
                        message.status === "failed" &&
                          message.role === "assistant" &&
                          "text-destructive"
                      )}
                    >
                      {message.role === "assistant" ? (
                        <>
                          {message.status === "running" && streamProviderEvents.length ? (
                            <ProviderActivity events={streamProviderEvents} />
                          ) : persistedProviderEvents.length ? (
                            <ProviderActivity events={persistedProviderEvents} />
                          ) : null}
                          {message.thought ? (
                            <ThoughtTrace
                              thought={message.thought}
                              durationMs={message.durationMs}
                              status={message.status}
                              startedAt={message.createdAt}
                            />
                          ) : null}
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
                                if (activeChatId)
                                  setSourceSelection({
                                    chatId: activeChatId,
                                    messageId: message.id,
                                    citationId: citation.id,
                                  })
                              }}
                              onAddAnnotation={(selectedText) =>
                                addAnnotation(message.id, selectedText)
                              }
                              onSaveAnnotation={saveAnnotation}
                              onDeleteAnnotation={deleteAnnotation}
                            />
                          ) : message.status === "running" &&
                            !message.thought ? (
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                              Blitz is reading your context…
                            </span>
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
                      <div
                        className={cn(
                          "mt-1 flex flex-wrap items-center gap-1 text-muted-foreground",
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
                            {"agentRequests" in message &&
                            Array.isArray(message.agentRequests)
                              ? message.agentRequests
                                  .map((value) => agentRequestFromValue(value))
                                  .filter(
                                    (request): request is AgentRequest =>
                                      request !== undefined &&
                                      request.status !== "pending"
                                  )
                                  .map((request) => (
                                    <AgentRequestPanel
                                      key={`history-${request.id}`}
                                      request={request}
                                      readOnly
                                      onSubmit={() => undefined}
                                    />
                                  ))
                              : null}
                            {latest &&
                            message.status === "running" &&
                            (sending || activeChat?.status === "running") ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                                onClick={pauseReply}
                              >
                                <HugeiconsIcon
                                  icon={PauseIcon}
                                  size={14}
                                  aria-hidden="true"
                                />
                                Pause
                              </Button>
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
                    ) : null}
                  </article>
                )
              })}
              <div ref={messageEndRef} />
            </div>
          )}
        </section>

        <div className="mx-auto w-full max-w-3xl shrink-0 pb-3">
          {persistedAttachments.length ||
          attachments.length ||
          draftAnnotations.length ? (
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 px-1">
              <ul
                aria-label="Attached context"
                className="flex min-w-0 flex-wrap items-center gap-1.5"
              >
                {persistedAttachments.map((attachment) => (
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
                  />
                ))}
                {attachments.map((attachment) => (
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
              busy={
                requestFixtureRequest
                  ? false
                  : approvalBusy === visibleComposerRequest.request.id
              }
              onSubmit={(submission) => {
                if (requestFixtureRequest) {
                  resolveRequestUiFixture()
                  return
                }
                void decideAgentRequest(
                  visibleComposerRequest.request,
                  visibleComposerRequest.messageId,
                  submission
                )
              }}
            />
          ) : null}
          <div
            className={cn(
              "rounded-[24px] border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40",
              draggingFiles && "border-brand bg-brand/5 ring-2 ring-brand/30"
            )}
            onDragEnter={(event) => {
              event.preventDefault()
              if (!isRunning && event.dataTransfer.types.includes("Files"))
                setDraggingFiles(true)
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
            <Textarea
              aria-label="Message Blitz"
              value={draft}
              maxLength={4_000}
              rows={2}
              disabled={isRunning}
              placeholder="Ask Blitz about your material…"
              className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onPaste={handleComposerPaste}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  multiple
                  accept=".pdf,.md,.markdown,.txt,.pptx,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,image/webp,image/gif"
                  onChange={(event) =>
                    void chooseFiles(Array.from(event.target.files ?? []))
                  }
                />
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="rounded-full"
                      disabled={isRunning || !canAttach}
                      aria-label="Attach context"
                    >
                      <HugeiconsIcon
                        icon={PlusIcon}
                        size={19}
                        strokeWidth={1.8}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem
                      onSelect={() => fileInputRef.current?.click()}
                    >
                      <HugeiconsIcon icon={File01Icon} size={17} />
                      Upload file
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setLinkDialogOpen(true)}>
                      <HugeiconsIcon icon={Link02Icon} size={17} />
                      Add link
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!canAttachProject}
                      onSelect={() => setProjectDialogOpen(true)}
                    >
                      <HugeiconsIcon icon={Folder01Icon} size={17} />
                      Add project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <ReplyModelPicker
                  disabled={isRunning}
                  onSaveStateChange={setSavingReplySettings}
                />
                <ChatAgentControls
                  autonomy={effectiveAgentAutonomy}
                  additionalInstructions={effectiveAgentInstructions}
                  workingProjectId={effectiveWorkingProjectId}
                  projects={projects}
                  disabled={isRunning}
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
                {process.env.NODE_ENV !== "production" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    disabled={isRunning && requestFixtureStep === undefined}
                    onClick={startRequestUiFixture}
                  >
                    {requestFixtureStep === undefined
                      ? "Test requests"
                      : "Restart test"}
                  </Button>
                ) : null}
              </div>
              <Button
                type="button"
                size="icon"
                aria-label={sending ? "Pause response" : "Send message"}
                className="ml-auto shrink-0 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                disabled={
                  sending
                    ? false
                    : (!draft.trim() && !draftAnnotations.length) || isRunning
                }
                onClick={sending ? pauseReply : () => void sendMessage()}
              >
                {sending ? (
                  <HugeiconsIcon icon={PauseIcon} size={18} strokeWidth={2} />
                ) : (
                  <HugeiconsIcon icon={SendIcon} size={18} strokeWidth={2} />
                )}
              </Button>
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

      {sourceSelection ? (
        <SourcePane
          key={`${sourceSelection.messageId}:${sourceSelection.citationId}`}
          selection={sourceSelection}
          onClose={() => setSourceSelection(undefined)}
        />
      ) : null}

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          className="h-[min(680px,calc(100svh-2rem))] min-w-0 overflow-hidden p-0 sm:max-w-sm"
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
  onRemove,
}: {
  kind: "card" | "project" | "file" | "link"
  label: string
  previewUrl?: string
  onRemove?: () => void
}) {
  return (
    <li className="group relative flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 text-xs text-foreground backdrop-blur-xs transition-colors hover:border-border hover:bg-muted/60">
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
    </li>
  )
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
