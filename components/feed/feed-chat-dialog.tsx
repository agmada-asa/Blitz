"use client"

/** Renders the attached-card chat dialog and streams persisted replies. */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import { Markdown } from "@/components/ui/markdown"
import { watchChatStream } from "@/lib/chat-stream"
import type { FeedCard } from "@/lib/learning/client-contracts"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { CancelIcon } from "@/components/ui/icon"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { useBackgroundNotice } from "@/components/background-notices"

/** Status values returned for one persisted learner message. */
type ChatMessageStatus = "queued" | "running" | "completed" | "failed"

/** Status values returned for one card conversation. */
type ChatConversationStatus = "idle" | "queued" | "running" | "failed"

/** One message returned by the card-chat polling endpoint. */
type ChatMessage = {
  id: string
  clientMessageId: string
  question: string
  status: ChatMessageStatus
  reply?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/** The polling response returned by the card-chat endpoint. */
type ChatResponse = {
  conversationId: string | null
  codexThreadId: string | null
  status: ChatConversationStatus
  lastError: string | null
  messages: ChatMessage[]
}

/** The enqueue response returned after a learner question is accepted. */
type EnqueueResponse = {
  conversationId: string
  message: ChatMessage
  alreadyQueued: boolean
}

/** Local state retained independently for every card opened in the dialog. */
type ChatCardState = {
  draftQuestion: string
  draftMessageId?: string
  messages: ChatMessage[]
  status: ChatConversationStatus
  lastError: string
  requestError: string
  loading: boolean
  sending: boolean
}

/** Empty state used when a card has not opened a conversation yet. */
const EMPTY_CHAT_STATE: ChatCardState = {
  draftQuestion: "",
  messages: [],
  status: "idle",
  lastError: "",
  requestError: "",
  loading: false,
  sending: false,
}

/** Props controlling the attached-card chat dialog. */
type FeedChatDialogProps = {
  card: Pick<FeedCard, "id" | "projectId" | "title" | "sourceLabel"> | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Returns a stable client message identifier for idempotent retries. */
function createClientMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads the safe error string returned by a failed chat request. */
async function readChatError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown }
    return typeof payload.error === "string" ? payload.error : fallback
  } catch {
    return fallback
  }
}

/** Shows one selected card, learner-authored questions, and queued replies. */
export function FeedChatDialog({
  card,
  open,
  onOpenChange,
}: FeedChatDialogProps) {
  const [states, setStates] = useState<Record<string, ChatCardState>>({})
  const cardKey = card ? `${card.projectId}:${card.id}` : ""
  const state = states[cardKey] ?? EMPTY_CHAT_STATE
  const notify = useBackgroundNotice()
  const scrollRef = useRef<HTMLDivElement>(null)
  const followReply = useRef(true)

  useEffect(() => {
    const view = scrollRef.current
    if (view && followReply.current) view.scrollTop = view.scrollHeight
  }, [state.messages])

  /** Acknowledges persisted replies that continue after the drawer closes. */
  function changeOpen(nextOpen: boolean) {
    if (
      !nextOpen &&
      state.messages.some(
        (message) => message.status === "queued" || message.status === "running"
      )
    ) {
      notify(
        "Your reply is being prepared in the background.",
        card
          ? `/chat?projectId=${encodeURIComponent(card.projectId)}&itemId=${encodeURIComponent(card.id)}`
          : "/notifications",
        "View"
      )
    }
    onOpenChange(nextOpen)
  }

  /** Updates only the conversation state belonging to the selected card. */
  const updateState = useCallback(
    (
      update:
        Partial<ChatCardState> | ((current: ChatCardState) => ChatCardState)
    ) => {
      if (!cardKey) return
      setStates((currentStates) => {
        const current = currentStates[cardKey] ?? EMPTY_CHAT_STATE
        const next =
          typeof update === "function"
            ? update(current)
            : { ...current, ...update }
        return { ...currentStates, [cardKey]: next }
      })
    },
    [cardKey]
  )

  /** Subscribes while open and restores persisted history after reconnection. */
  useEffect(() => {
    if (!open || !card) return
    const controller = new AbortController()
    followReply.current = true
    updateState({ loading: true, requestError: "" })
    const params = new URLSearchParams({
      projectId: card.projectId,
      itemId: card.id,
      stream: "1",
    })
    void watchChatStream(`/api/learning/chat?${params}`, {
      signal: controller.signal,
      onSnapshot: (value) => {
        const next = value as ChatResponse
        updateState({
          messages: next.messages,
          status: next.status,
          lastError: next.lastError ?? "",
          requestError: "",
          loading: false,
        })
      },
      onError: (requestError) => updateState({ requestError, loading: false }),
    })
    return () => controller.abort()
  }, [card, open, updateState])

  /** Queues one learner question and merges the server message into the view. */
  const enqueueQuestion = useCallback(
    async (question: string, clientMessageId: string, clearDraft: boolean) => {
      if (!card) return
      updateState({ sending: true, requestError: "" })
      try {
        const response = await fetch("/api/learning/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectId: card.projectId,
            itemId: card.id,
            clientMessageId,
            question,
          }),
        })
        if (!response.ok) {
          throw new Error(
            await readChatError(response, "Could not send question.")
          )
        }
        const result = (await response.json()) as EnqueueResponse
        updateState((current) => {
          const existingIndex = current.messages.findIndex(
            (message) =>
              message.clientMessageId === result.message.clientMessageId
          )
          const messages = [...current.messages]
          if (existingIndex === -1) messages.push(result.message)
          else if (
            messages[existingIndex].updatedAt <= result.message.updatedAt
          )
            messages[existingIndex] = result.message
          return {
            ...current,
            messages,
            status: result.message.status === "failed" ? "failed" : "queued",
            lastError: result.message.error ?? "",
            requestError: result.message.error ?? "",
            draftQuestion: clearDraft ? "" : current.draftQuestion,
            draftMessageId: clearDraft ? undefined : current.draftMessageId,
            sending: false,
          }
        })
      } catch (reason) {
        // Preserve the draft and its ID so a retry resubmits the same payload.
        updateState((current) => ({
          ...current,
          sending: false,
          requestError:
            reason instanceof Error
              ? reason.message
              : "Could not send question.",
        }))
      }
    },
    [card, updateState]
  )

  /** Submits the current draft while retaining its stable retry identifier. */
  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const question = state.draftQuestion.trim()
    if (!card || !question || state.sending) return
    const clientMessageId = state.draftMessageId ?? createClientMessageId()
    updateState({ draftMessageId: clientMessageId })
    void enqueueQuestion(question, clientMessageId, true)
  }

  /** Updates the draft and starts a new idempotency key when its text changes. */
  function changeQuestion(value: string) {
    updateState({
      draftQuestion: value,
      draftMessageId: undefined,
      requestError: "",
    })
  }

  /** Requeues one failed message through the server's explicit retry endpoint. */
  async function retryMessage(message: ChatMessage) {
    if (!card || state.sending) return
    updateState({ sending: true, requestError: "" })
    try {
      const response = await fetch("/api/learning/chat/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: card.projectId,
          itemId: card.id,
          messageId: message.id,
        }),
      })
      if (!response.ok) {
        throw new Error(
          await readChatError(response, "Could not retry question.")
        )
      }
      updateState((current) => ({
        ...current,
        messages: current.messages.map((currentMessage) =>
          currentMessage.id === message.id
            ? {
                ...currentMessage,
                status: "queued",
                error: undefined,
                reply: undefined,
                updatedAt: Date.now(),
              }
            : currentMessage
        ),
        status: "queued",
        lastError: "",
        sending: false,
      }))
    } catch (reason) {
      updateState((current) => ({
        ...current,
        sending: false,
        requestError:
          reason instanceof Error
            ? reason.message
            : "Could not retry question.",
      }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="!top-auto !right-0 !bottom-0 !left-0 !h-[88dvh] !max-h-[100dvh] !max-w-none !translate-x-0 !translate-y-0 !gap-0 !overflow-hidden !rounded-t-[28px] !rounded-b-none border-border bg-card p-0 text-foreground shadow-2xl shadow-black/20 sm:!top-0 sm:!bottom-auto sm:!left-auto sm:!h-full sm:!max-w-md sm:!rounded-t-none sm:!rounded-l-[28px]"
      >
        <div className="flex h-full min-h-0 flex-col">
          <DialogHeader className="shrink-0 border-b border-border px-5 pt-5 pb-5 sm:px-7 sm:pt-7">
            <div className="flex items-start justify-between gap-5">
              <DialogTitle className="font-sans text-xl tracking-[-0.03em] text-foreground">
                Ask about this card
              </DialogTitle>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close chat"
                  className="-mt-2 -mr-2 shrink-0 rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <CancelIcon aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>
          </DialogHeader>

          {card ? (
            <div className="mx-5 mt-5 shrink-0 rounded-2xl border border-border bg-muted/40 p-4 sm:mx-7 sm:mt-7">
              <p className="line-clamp-3 text-sm leading-relaxed text-foreground/90">
                {card.title}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                Source · {card.sourceLabel}
              </p>
            </div>
          ) : null}

          <div
            ref={scrollRef}
            onScroll={(event) => {
              const view = event.currentTarget
              followReply.current =
                view.scrollHeight - view.scrollTop - view.clientHeight < 80
            }}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 pt-5 sm:px-7"
          >
            {state.loading && !state.messages.length ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading chat…
              </p>
            ) : null}
            <div className="space-y-4">
              {state.messages.map((message) => (
                <div key={message.id} className="space-y-2">
                  <div className="rounded-2xl bg-brand px-4 py-3 text-sm leading-relaxed text-brand-foreground">
                    {message.question}
                  </div>
                  {message.reply ? (
                    <div className="rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed text-foreground/90">
                      <Markdown text={message.reply} />
                    </div>
                  ) : null}
                  {message.status === "queued" ? (
                    <p className="text-xs text-muted-foreground">
                      Queued · <ElapsedTime since={message.updatedAt} />
                    </p>
                  ) : null}
                  {message.status === "running" ? (
                    <p className="text-xs text-muted-foreground">
                      {message.reply ? "Replying…" : "Preparing reply…"}
                    </p>
                  ) : null}
                  {message.status === "failed" ? (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs leading-relaxed text-destructive">
                        {message.error || "Could not answer that question."}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => retryMessage(message)}
                        disabled={state.sending}
                        className="h-9 shrink-0 rounded-xl px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {state.messages.some(
              (message) =>
                message.status === "queued" || message.status === "running"
            ) ? (
              <p className="mt-4 text-xs text-muted-foreground" role="status">
                You can close chat. Your reply will be saved here.
              </p>
            ) : null}
          </div>

          <form
            onSubmit={submitQuestion}
            className="flex shrink-0 flex-col gap-3 px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:mt-auto sm:px-7 sm:pb-7"
          >
            <label
              htmlFor="feed-chat-question"
              className="text-sm font-medium text-foreground/80"
            >
              Your question
            </label>
            <Textarea
              id="feed-chat-question"
              value={state.draftQuestion}
              onChange={(event) => changeQuestion(event.target.value)}
              placeholder="Ask a follow-up"
              rows={2}
              disabled={state.sending}
              className="min-h-20 resize-none rounded-2xl border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:border-brand focus-visible:ring-brand/30"
            />
            {state.requestError ? (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {state.requestError}
              </p>
            ) : state.lastError &&
              !state.messages.some((message) => message.status === "failed") ? (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {state.lastError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!state.draftQuestion.trim() || state.sending}
                className="h-11 shrink-0 rounded-full bg-brand px-5 text-sm font-medium text-brand-foreground hover:bg-brand/85 focus-visible:ring-brand/50"
              >
                {state.sending ? "Sending…" : "Send question"}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
