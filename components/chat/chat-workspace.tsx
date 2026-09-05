"use client"

/** Owns the general Codex conversation UI and its mixed-context attachments. */

import {
  Attachment02Icon,
  BubbleChatIcon,
  File01Icon,
  Folder01Icon,
  Link02Icon,
  Sent02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useQuery } from "convex/react"
import { useRef, useState, type KeyboardEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Textarea } from "@/components/ui/textarea"
import { CancelIcon, LoadingIcon, SparklesIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  extractSource,
  extractSourceResponse,
} from "@/lib/client/extract-source"
import { cn } from "@/lib/utils"

/** Maximum context items accepted by the server for one conversation turn. */
const MAX_ATTACHMENTS = 8
/** Maximum extracted characters retained for one browser-owned attachment. */
const MAX_ATTACHMENT_TEXT = 48_000

/** One project, file, or public link shown above the message composer. */
type ChatAttachment = {
  id: string
  kind: "project" | "file" | "link"
  label: string
  sent: boolean
  projectId?: Id<"projects">
  text?: string
  url?: string
}

/** One visible user or Codex message in the active browser conversation. */
type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  status?: "streaming" | "failed"
}

/** Narrow event shapes returned by the workspace chat NDJSON stream. */
type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "complete"; threadId: string }
  | { type: "error"; message: string }

/** Returns a readable error without exposing an arbitrary response object. */
function messageForError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback
}

/** Parses one server event and rejects malformed stream data. */
function parseChatEvent(value: unknown): ChatEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Codex returned an invalid response.")
  const event = value as Record<string, unknown>
  if (event.type === "delta" && typeof event.text === "string")
    return { type: "delta", text: event.text }
  if (event.type === "complete" && typeof event.threadId === "string")
    return { type: "complete", threadId: event.threadId }
  if (event.type === "error" && typeof event.message === "string")
    return { type: "error", message: event.message }
  throw new Error("Codex returned an invalid response.")
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

/** Displays a responsive conversation with project, file, and link attachments. */
export function ChatWorkspace() {
  const projects = useQuery(api.projects.listProjects)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState("")
  const [threadId, setThreadId] = useState<string>()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState("")
  const [importingLink, setImportingLink] = useState(false)

  /** Reports whether another context item can fit in the current conversation. */
  const canAttach = attachments.length < MAX_ATTACHMENTS

  /** Adds an attachment unless the same project or URL is already present. */
  const addAttachment = (attachment: ChatAttachment): void => {
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

  /** Extracts supported local files and attaches their bounded text in selection order. */
  const chooseFiles = async (files: File[]): Promise<void> => {
    setError("")
    const selected = files.slice(
      0,
      Math.max(0, MAX_ATTACHMENTS - attachments.length)
    )
    for (const file of selected) {
      try {
        const source = await extractSource(file)
        if (!source.text.trim())
          throw new Error("There was no readable text in that file.")
        addAttachment({
          id: crypto.randomUUID(),
          kind: "file",
          label: source.filename,
          text: source.text.slice(0, MAX_ATTACHMENT_TEXT),
          sent: false,
        })
      } catch (fileError) {
        setError(messageForError(fileError, `Could not read ${file.name}.`))
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ""
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
      const source = await extractSourceResponse(response, url)
      if (!source.text.trim())
        throw new Error("There was no readable text at that link.")
      addAttachment({
        id: crypto.randomUUID(),
        kind: "link",
        label: source.filename,
        text: source.text.slice(0, MAX_ATTACHMENT_TEXT),
        url: response.headers.get("x-source-url") ?? url,
        sent: false,
      })
      setLinkUrl("")
      setLinkDialogOpen(false)
    } catch (linkError) {
      setError(messageForError(linkError, "That link could not be attached."))
    } finally {
      setImportingLink(false)
    }
  }

  /** Removes context that has not already entered the Codex thread. */
  const removeAttachment = (id: string): void => {
    setAttachments((current) =>
      current.filter((attachment) => attachment.id !== id || attachment.sent)
    )
  }

  /** Clears the local transcript and starts a fresh Codex thread. */
  const startNewChat = (): void => {
    if (sending) return
    setMessages([])
    setAttachments([])
    setThreadId(undefined)
    setDraft("")
    setError("")
  }

  /** Sends one message and applies streamed deltas to its assistant placeholder. */
  const sendMessage = async (): Promise<void> => {
    const message = draft.trim()
    if (!message || sending) return
    const newAttachments = attachments.filter((attachment) => !attachment.sent)
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
    }
    const assistantId = crypto.randomUUID()
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: "assistant", content: "", status: "streaming" },
    ])
    setDraft("")
    setError("")
    setSending(true)
    let completedThreadId: string | undefined
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(threadId ? { threadId } : {}),
          projectIds: newAttachments.flatMap((attachment) =>
            attachment.kind === "project" && attachment.projectId
              ? [attachment.projectId]
              : []
          ),
          attachments: newAttachments.flatMap((attachment) =>
            attachment.kind !== "project" && attachment.text
              ? [
                  {
                    kind: attachment.kind,
                    label: attachment.label,
                    text: attachment.text,
                    ...(attachment.url ? { url: attachment.url } : {}),
                  },
                ]
              : []
          ),
        }),
      })
      if (!response.ok || !response.body) {
        const result = (await response.json().catch(() => null)) as {
          error?: string
        } | null
        throw new Error(result?.error || "Codex could not start that reply.")
      }
      await readChatEvents(response.body, (event) => {
        if (event.type === "error") throw new Error(event.message)
        if (event.type === "complete") {
          completedThreadId = event.threadId
          return
        }
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId
              ? { ...item, content: item.content + event.text }
              : item
          )
        )
      })
      if (!completedThreadId) throw new Error("Codex ended the reply early.")
      setThreadId(completedThreadId)
      const sentIds = new Set(newAttachments.map((attachment) => attachment.id))
      setAttachments((current) =>
        current.map((attachment) =>
          sentIds.has(attachment.id)
            ? { ...attachment, sent: true }
            : attachment
        )
      )
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId ? { ...item, status: undefined } : item
        )
      )
    } catch (sendError) {
      const failure = messageForError(
        sendError,
        "Codex could not finish that reply. Try again."
      )
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, content: item.content || failure, status: "failed" }
            : item
        )
      )
      setError(failure)
    } finally {
      setSending(false)
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

  return (
    <main className="mx-auto flex min-h-[calc(100svh-76px)] w-full max-w-5xl flex-col px-4 pb-4 sm:px-8 md:min-h-svh md:py-6">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 md:h-14">
        <div>
          <h1 className="text-xl font-medium tracking-tight md:text-2xl">
            Chat
          </h1>
          <p className="hidden text-sm text-muted-foreground sm:block">
            Work through your sources with Codex.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          disabled={sending || (!messages.length && !attachments.length)}
          onClick={startNewChat}
        >
          New chat
        </Button>
      </header>

      <section
        aria-label="Conversation"
        className="flex min-h-0 flex-1 flex-col overflow-y-auto py-5"
      >
        {!messages.length ? (
          <div className="m-auto max-w-xl px-4 py-12 text-center">
            <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
              <HugeiconsIcon
                icon={BubbleChatIcon}
                size={25}
                strokeWidth={1.8}
              />
            </span>
            <h2 className="mt-5 text-2xl font-medium tracking-tight">
              Ask about your material
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              Attach a project, PDF, notes, PowerPoint, or public link. Codex
              will use that material as context for the conversation.
            </p>
          </div>
        ) : (
          <div
            className="mx-auto flex w-full max-w-3xl flex-col gap-6"
            aria-live="polite"
          >
            {messages.map((message) => (
              <article
                key={message.id}
                className={cn(
                  "max-w-[88%] text-sm leading-6 sm:max-w-[78%]",
                  message.role === "user"
                    ? "ml-auto rounded-2xl rounded-br-md bg-foreground px-4 py-3 text-background"
                    : "mr-auto min-w-0",
                  message.status === "failed" && "text-destructive"
                )}
              >
                {message.role === "assistant" ? (
                  message.content ? (
                    <Markdown text={message.content} />
                  ) : (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                      Codex is reading your context…
                    </span>
                  )
                ) : (
                  <p className="whitespace-pre-wrap">{message.content}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <div className="mx-auto w-full max-w-3xl shrink-0">
        {attachments.length ? (
          <ul
            aria-label="Attached context"
            className="mb-2 flex flex-wrap gap-2"
          >
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex max-w-full min-w-0 items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs"
              >
                <HugeiconsIcon
                  icon={
                    attachment.kind === "project"
                      ? Folder01Icon
                      : attachment.kind === "link"
                        ? Link02Icon
                        : File01Icon
                  }
                  size={14}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <span className="max-w-52 truncate">{attachment.label}</span>
                {attachment.sent ? (
                  <span className="pr-2 text-muted-foreground">In chat</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.label}`}
                    className="flex size-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <CancelIcon className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rounded-[24px] border bg-card p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
          <Textarea
            aria-label="Message Codex"
            value={draft}
            maxLength={4_000}
            rows={2}
            disabled={sending}
            placeholder="Ask Codex about your material…"
            className="max-h-40 min-h-16 resize-none border-0 bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />
          <div className="flex items-center justify-between gap-3">
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
                  disabled={sending || !canAttach}
                  aria-label="Attach context"
                >
                  <HugeiconsIcon
                    icon={Attachment02Icon}
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
                <DropdownMenuItem onSelect={() => setProjectDialogOpen(true)}>
                  <HugeiconsIcon icon={Folder01Icon} size={17} />
                  Add project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              size="icon"
              aria-label="Send message"
              className="ml-auto rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
              disabled={!draft.trim() || sending}
              onClick={() => void sendMessage()}
            >
              {sending ? (
                <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <HugeiconsIcon icon={Sent02Icon} size={18} strokeWidth={2} />
              )}
            </Button>
          </div>
        </div>
        <div className="min-h-6 px-3 pt-1.5">
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-center text-[11px] text-muted-foreground">
              Codex can make mistakes. Check important details against your
              sources.
            </p>
          )}
        </div>
      </div>

      <Dialog open={projectDialogOpen} onOpenChange={setProjectDialogOpen}>
        <DialogContent aria-describedby="project-chat-description">
          <DialogHeader>
            <DialogTitle>Attach a project</DialogTitle>
            <DialogDescription id="project-chat-description">
              Codex will read up to eight ready sources from the project.
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
                    disabled={attached || !canAttach}
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                    onClick={() => {
                      addAttachment({
                        id: crypto.randomUUID(),
                        kind: "project",
                        label: project.title,
                        projectId: project._id,
                        sent: false,
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
