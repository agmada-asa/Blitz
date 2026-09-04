"use client"

/** Owns the responsive attached-card chat preview and its local-only submit state. */

import { useState, type FormEvent } from "react"

import type { PreviewCardData } from "@/components/preview/preview-data"
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

/** Props controlling the attached-card chat panel. */
type PreviewChatPanelProps = {
  card: PreviewCardData | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Renders a responsive sheet that accepts input without pretending to call an agent. */
export function PreviewChatPanel({
  card,
  open,
  onOpenChange,
}: PreviewChatPanelProps) {
  const [message, setMessage] = useState("")
  const [submitted, setSubmitted] = useState(false)

  /** Keeps the chat submit action local and explains the preview limitation. */
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!message.trim()) return
    setSubmitted(true)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className="!top-auto !right-0 !bottom-0 !left-0 !h-auto !max-w-none !translate-x-0 !translate-y-0 !gap-0 !rounded-t-[28px] !rounded-b-none border-white/10 bg-[#151515] p-0 text-white shadow-2xl shadow-black/45 sm:!top-0 sm:!bottom-auto sm:!left-auto sm:!h-full sm:!max-w-md sm:!rounded-t-none sm:!rounded-l-[28px]"
      >
        <div className="flex max-h-[88svh] flex-col sm:h-full sm:max-h-none">
          <DialogHeader className="border-b border-white/10 px-5 pt-5 pb-5 sm:px-7 sm:pt-7">
            <div className="flex items-start justify-between gap-5">
              <div>
                <DialogTitle className="font-sans text-xl tracking-[-0.03em] text-white">
                  Ask about this idea
                </DialogTitle>
              </div>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close chat preview"
                  className="-mt-2 -mr-2 shrink-0 rounded-xl text-white/55 hover:bg-white/10 hover:text-white"
                >
                  <CancelIcon aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>
          </DialogHeader>

          {card ? (
            <div className="mx-5 mt-5 rounded-2xl border border-white/10 bg-white/[0.045] p-4 sm:mx-7 sm:mt-7">
              <p className="text-xs text-white/45">{card.sourceLabel}</p>
              <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-white/80">
                {card.title}
              </p>
            </div>
          ) : null}

          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3 px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:mt-auto sm:px-7 sm:pb-7"
          >
            <label
              htmlFor="preview-chat-message"
              className="text-sm font-medium text-white/72"
            >
              Your question
            </label>
            <Textarea
              id="preview-chat-message"
              value={message}
              onChange={(event) => {
                setMessage(event.target.value)
                setSubmitted(false)
              }}
              placeholder="What would you try next?"
              rows={4}
              className="min-h-28 resize-none rounded-2xl border-white/12 bg-white/[0.045] text-white placeholder:text-white/30 focus-visible:border-[#ff8065] focus-visible:ring-[#ff8065]/30"
            />
            <div className="flex items-center justify-between gap-3">
              <p
                aria-live="polite"
                className="text-xs leading-relaxed text-white/42"
              >
                {submitted
                  ? "Preview: message not sent."
                  : "AI replies are unavailable in this preview."}
              </p>
              <Button
                type="submit"
                disabled={!message.trim()}
                className="h-11 shrink-0 rounded-[20px] bg-[#ff8065] px-5 text-sm font-medium text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
              >
                Add question
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  )
}
