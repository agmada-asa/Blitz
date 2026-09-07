"use client"

/** Owns persisted Blitz chat selection, streaming, and mixed-context attachments. */

import {
  BookTextIcon,
  Chat01Icon,
  Copy01Icon,
  File01Icon,
  Folder01Icon,
  Link02Icon,
  Menu01Icon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlusIcon,
  SendIcon,
  SplitIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useMutation, useQuery } from "convex/react"
import Link from "next/link"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"

import {
  ChatHistory,
  type ChatHistoryItem,
} from "@/components/chat/chat-history"
import {
  NewChatDialog,
  type NewChatProject,
} from "@/components/chat/new-chat-dialog"
import {
  ChatAgentControls,
  type ChatAgentAutonomy,
  type ChatAgentProject,
  readCachedAgentAutonomy,
  useCachedAgentAutonomy,
  writeCachedAgentAutonomy,
} from "@/components/chat/chat-agent-controls"
import { ReplyModelPicker } from "@/components/chat/reply-model-picker"
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Markdown } from "@/components/ui/markdown"
import { SourcePane } from "@/components/chat/source-pane"
import { Textarea } from "@/components/ui/textarea"
import { CancelIcon, LoadingIcon, SparklesIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { extractSourceResponse } from "@/lib/client/extract-source"
import { cn } from "@/lib/utils"

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
  id: string
  kind: "card" | "project" | "file" | "link"
  label: string
  projectId?: Id<"projects">
  itemId?: Id<"learningItems">
  text?: string
  url?: string
}

/** Narrow event shapes returned by the workspace chat stream. */
type ChatEvent =
  | { type: "started"; chatId: Id<"workspaceChats"> }
  | { type: "delta"; text: string }
  | { type: "complete"; chatId: Id<"workspaceChats">; threadId: string }
  | {
      type: "approval"
      chatId: Id<"workspaceChats">
      messageId: string
      approval: ChatApproval
    }
  | { type: "approval-resolved"; approvalId: string }
  | { type: "error"; message: string }

/** Approval request emitted while an agent is waiting for user authorization. */
type ChatApproval = {
  id: string
  method: string
  details: string
  expiresAt: number
  status: "pending" | "approved" | "denied"
}

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
  if (
    event.type === "complete" &&
    typeof event.chatId === "string" &&
    typeof event.threadId === "string"
  )
    return {
      type: "complete",
      chatId: event.chatId as Id<"workspaceChats">,
      threadId: event.threadId,
    }
  if (
    event.type === "approval" &&
    typeof event.chatId === "string" &&
    typeof event.messageId === "string" &&
    event.approval &&
    typeof event.approval === "object"
  ) {
    const approval = event.approval as Record<string, unknown>
    if (
      typeof approval.id === "string" &&
      typeof approval.method === "string" &&
      typeof approval.details === "string" &&
      typeof approval.expiresAt === "number" &&
      approval.status === "pending"
    )
      return {
        type: "approval",
        chatId: event.chatId as Id<"workspaceChats">,
        messageId: event.messageId,
        approval: approval as unknown as ChatApproval,
      }
  }
  if (
    event.type === "approval-resolved" &&
    typeof event.approvalId === "string"
  )
    return { type: "approval-resolved", approvalId: event.approvalId }
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
  const chats = useQuery(api.workspaceChats.list) as
    ChatHistoryItem[] | undefined
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageEndRef = useRef<HTMLDivElement>(null)
  const requestControllerRef = useRef<AbortController | undefined>(undefined)
  const pausedByUserRef = useRef(false)
  const branchChat = useMutation(api.workspaceChats.branch)
  const createProject = useMutation(api.projects.createProject)
  const renameChat = useMutation(api.workspaceChats.rename)
  const setChatUnread = useMutation(api.workspaceChats.setUnread)
  const setChatPinned = useMutation(api.workspaceChats.setPinned)
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
  const [sending, setSending] = useState(false)
  const [savingReplySettings, setSavingReplySettings] = useState(false)
  const [messageActionId, setMessageActionId] = useState<string>()
  const [copiedMessageId, setCopiedMessageId] = useState<string>()
  const [editingMessageId, setEditingMessageId] = useState<string>()
  const [editDraft, setEditDraft] = useState("")
  const [error, setError] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const [sourceSelection, setSourceSelection] = useState<{
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    citationId: string
  }>()
  const [renameChatId, setRenameChatId] = useState<Id<"workspaceChats">>()
  const [renameDraft, setRenameDraft] = useState("")
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
  const [streamApprovals, setStreamApprovals] = useState<
    Record<string, { approval: ChatApproval; messageId: string }>
  >({})
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
    Boolean(messageActionId)
  const canAttach = attachments.length < MAX_ATTACHMENTS
  const canAttachProject =
    canAttach &&
    attachments.filter((attachment) => attachment.kind === "project").length <
      MAX_PROJECT_ATTACHMENTS
  const renameTarget = chats?.find((chat) => chat.id === renameChatId)

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

  /** Clears a manual unread marker whenever a saved chat becomes active. */
  useEffect(() => {
    if (!activeChatId) return
    void setChatUnread({ chatId: activeChatId, unread: false }).catch(
      (cause) => {
        setError(
          messageForError(cause, "This chat could not be marked as read.")
        )
      }
    )
  }, [activeChatId, setChatUnread])

  /** Selects one saved chat and mirrors it in the address bar. */
  const selectChat = (chatId: Id<"workspaceChats">): void => {
    setSourceSelection(undefined)
    setActiveChatId(chatId)
    setAttachments([])
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setStreamApprovals({})
    setAgentAutonomy(undefined)
    setAgentSettingsTouched(false)
    setHistoryOpen(false)
    window.history.replaceState(
      null,
      "",
      `/chat?chatId=${encodeURIComponent(chatId)}`
    )
  }

  /** Opens project selection before clearing the current conversation. */
  const startNewChat = (): void => {
    if (isRunning) return
    setNewChatDialogOpen(true)
    setHistoryOpen(false)
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
    setError("")
    setEditingMessageId(undefined)
    setEditDraft("")
    setAgentAutonomy(readCachedAgentAutonomy())
    setAgentInstructions("")
    setWorkingProjectId(project._id)
    setNewChatProjectId(project._id)
    setStreamApprovals({})
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

  /** Saves selected originals before allowing a message to use them as source context. */
  const chooseFiles = async (files: File[]): Promise<void> => {
    if (uploadingFiles) return
    const projectId = activeChat?.projectId ?? newChatProjectId
    if (!projectId) {
      setError("Choose a project before attaching a file.")
      return
    }
    setUploadingFiles(true)
    setError("")
    const selected = files.slice(
      0,
      Math.max(0, MAX_ATTACHMENTS - attachments.length)
    )
    for (const file of selected) {
      try {
        if (file.size > 50_000_000)
          throw new Error("Chat files must be under 50 MB.")
        const response = await fetch("/api/chat/files", {
          method: "POST",
          headers: {
            "x-blitz-project-id": projectId,
            "x-blitz-filename": encodeURIComponent(file.name),
            "content-type": file.type || "application/octet-stream",
          },
          body: file,
        })
        const source = (await response.json()) as {
          documentId: Id<"chatDocuments">
          filename: string
          error?: string
        }
        if (!response.ok)
          throw new Error(source.error || "File could not be attached.")
        addAttachment({
          id: crypto.randomUUID(),
          kind: "file",
          label: source.filename,
          documentId: source.documentId,
        })
      } catch (fileError) {
        setError(messageForError(fileError, `Could not read ${file.name}.`))
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
    setUploadingFiles(false)
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
      const projectId = activeChat?.projectId ?? newChatProjectId
      if (projectId && /\.(pdf|pptx)$/i.test(source.filename)) {
        const saved = await fetch("/api/chat/files", {
          method: "POST",
          headers: {
            "x-blitz-project-id": projectId,
            "x-blitz-filename": encodeURIComponent(source.filename),
            "content-type":
              originalResponse.headers.get("content-type") ||
              "application/octet-stream",
          },
          body: await originalResponse.blob(),
        })
        const payload = (await saved.json()) as {
          documentId?: Id<"chatDocuments">
          error?: string
        }
        if (!saved.ok)
          throw new Error(
            payload.error || "The original file could not be saved."
          )
        documentId = payload.documentId
      }
      addAttachment({
        id: crypto.randomUUID(),
        kind: "link",
        ...(documentId ? { documentId } : {}),
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
    const message = (options.message ?? draft).trim()
    const targetChatId = options.chatId ?? activeChatId
    const targetProjectId = targetChatId ? undefined : newChatProjectId
    if (
      (!message && !options.continuationOf) ||
      sending ||
      uploadingFiles ||
      importingLink ||
      savingReplySettings ||
      (!options.chatId && activeChat?.status === "running") ||
      (options.continuationOf && !targetChatId)
    )
      return false
    if (!targetChatId && !targetProjectId) {
      setNewChatDialogOpen(true)
      return false
    }
    const submittedAttachments =
      options.message === undefined && !options.continuationOf
        ? attachments
        : []
    const cardAttachment = submittedAttachments.find(
      (attachment) =>
        attachment.kind === "card" && attachment.projectId && attachment.itemId
    )
    if (!options.continuationOf) setDraft("")
    setError("")
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
                    ...(attachment.url ? { url: attachment.url } : {}),
                  },
                ]
              : []
          ),
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
          setAttachments([])
          selectChat(event.chatId)
        }
        if (event.type === "approval") {
          setStreamApprovals((current) => ({
            ...current,
            [event.approval.id]: {
              approval: event.approval,
              messageId: event.messageId,
            },
          }))
        }
        if (event.type === "approval-resolved") {
          setStreamApprovals((current) => {
            const next = { ...current }
            delete next[event.approvalId]
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
      if (!started && !options.continuationOf) setDraft(message)
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

  /** Aborts the browser-owned request so the saved partial response can continue later. */
  const pauseReply = (): void => {
    if (!requestControllerRef.current) return
    pausedByUserRef.current = true
    requestControllerRef.current.abort()
  }

  /** Resolves a pending agent approval for the current chat message. */
  const decideApproval = async (
    approval: ChatApproval,
    messageId: string,
    decision: "approved" | "denied"
  ): Promise<void> => {
    if (!activeChatId) return
    setApprovalBusy(approval.id)
    setError("")
    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          messageId,
          approvalId: approval.id,
          decision,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      if (!response.ok)
        throw new Error(payload?.error || "Approval decision failed.")
      setStreamApprovals((current) => {
        const next = { ...current }
        delete next[approval.id]
        return next
      })
    } catch (cause) {
      setError(messageForError(cause, "Approval decision failed."))
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
      onRename={openRenameChat}
      onToggleUnread={toggleChatUnread}
      onTogglePin={toggleChatPinned}
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
                const persistedApproval =
                  "agentApproval" in message && message.agentApproval
                    ? (message.agentApproval as unknown as ChatApproval)
                    : undefined
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
                        message.content ? (
                          <Markdown
                            text={message.content}
                            citations={message.citations}
                            onCitation={(citation) => {
                              if (activeChatId)
                                setSourceSelection({
                                  chatId: activeChatId,
                                  messageId: message.id,
                                  citationId: citation.id,
                                })
                            }}
                          />
                        ) : message.status === "running" ? (
                          <span className="flex items-center gap-2 text-muted-foreground">
                            <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                            Blitz is reading your context…
                          </span>
                        ) : (
                          <p>
                            {activeChat?.lastError ||
                              "Blitz could not finish this reply."}
                          </p>
                        )
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
                        <p className="whitespace-pre-wrap">{message.content}</p>
                      )}
                    </div>

                    {persistedApproval?.status === "pending" && activeChatId ? (
                      <div className="mt-3 rounded-xl border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs">
                        <p className="font-medium">
                          Approval needed: {persistedApproval.method}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                          {persistedApproval.details}
                        </p>
                        <div className="mt-2 flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={approvalBusy === persistedApproval.id}
                            onClick={() =>
                              void decideApproval(
                                persistedApproval,
                                message.id,
                                "approved"
                              )
                            }
                          >
                            Approve
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={approvalBusy === persistedApproval.id}
                            onClick={() =>
                              void decideApproval(
                                persistedApproval,
                                message.id,
                                "denied"
                              )
                            }
                          >
                            Deny
                          </Button>
                        </div>
                      </div>
                    ) : null}

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
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
                                disabled={isRunning || Boolean(messageActionId)}
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
                            ) : null}
                            {latest &&
                            message.status === "running" &&
                            sending ? (
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
          {persistedAttachments.length || attachments.length ? (
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
                  />
                ))}
                {attachments.map((attachment) => (
                  <AttachmentChip
                    key={attachment.id}
                    kind={attachment.kind}
                    label={attachment.label}
                    onRemove={() => {
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
              </ul>
            </div>
          ) : null}
          <div className="rounded-[24px] border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
            <Textarea
              aria-label="Message Blitz"
              value={draft}
              maxLength={4_000}
              rows={2}
              disabled={isRunning}
              placeholder="Ask Blitz about your material…"
              className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  multiple
                  accept=".pdf,.md,.markdown,.txt,.pptx,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.presentationml.presentation"
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
              </div>
              <Button
                type="button"
                size="icon"
                aria-label={sending ? "Pause response" : "Send message"}
                className="ml-auto shrink-0 rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
                disabled={sending ? false : !draft.trim() || isRunning}
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
          {Object.values(streamApprovals).map(({ approval, messageId }) => (
            <div
              key={approval.id}
              className="mt-2 rounded-xl border border-orange-500/40 bg-orange-500/10 px-3 py-2 text-xs"
            >
              <p className="font-medium">Approval needed: {approval.method}</p>
              <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                {approval.details}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={approvalBusy === approval.id}
                  onClick={() =>
                    void decideApproval(approval, messageId, "approved")
                  }
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={approvalBusy === approval.id}
                  onClick={() =>
                    void decideApproval(approval, messageId, "denied")
                  }
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
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
  onRemove,
}: {
  kind: "card" | "project" | "file" | "link"
  label: string
  onRemove?: () => void
}) {
  return (
    <li className="group relative flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2.5 text-xs text-foreground backdrop-blur-xs transition-colors hover:border-border hover:bg-muted/60">
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
