"use client"

/**
 * Small pieces of a chat message: the attachment chips above the composer and
 * on sent messages, the draft annotations chip, and a sent message's body with
 * its quoted passage and annotations badge. Used by the chat workspace.
 */
import {
  BookTextIcon,
  File01Icon,
  Folder01Icon,
  Link02Icon,
  QuoteUpIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import Image from "next/image"
import { useState } from "react"

import { type FloatingAnnotation } from "@/components/chat/floating-annotation-chip"
import { CancelIcon } from "@/components/ui/icon"
import { Markdown } from "@/components/ui/markdown"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** Renders one persisted or removable attachment with hover-revealed removal controls. */
export function AttachmentChip({
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
export function AnnotationAttachmentChip({
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
 * Shows a quoted lesson passage. Quotes keep their maths as TeX, so those are
 * drawn; anything else stays literal, because a quoted line of code isn't Markdown.
 *
 * @param text - The quote.
 */
export function QuotedPassage({ text }: { text: string }) {
  return text.includes("$") ? <Markdown text={text} /> : <>{text}</>
}

/**
 * Renders a sent message. A passage quoted from a lesson is the message's own
 * subject, so it shows above the text; notes on this chat's replies stay in
 * their badge.
 *
 * @param content - The message text.
 * @param annotations - The annotations sent with it. One whose note is the
 * message itself was quoted from a lesson.
 */
export function UserMessageBody({
  content,
  annotations,
}: {
  content: string
  annotations: FloatingAnnotation[]
}) {
  const quotes = annotations.filter((item) => item.note === content)
  const notes = annotations.filter((item) => item.note !== content)
  return (
    <div>
      {quotes.map((quote) => (
        <blockquote
          key={quote.id}
          className="mb-1.5 line-clamp-4 border-l-2 border-current/40 pl-2 text-xs whitespace-pre-line opacity-80"
        >
          <QuotedPassage text={quote.selectedText} />
        </blockquote>
      ))}
      {content ? <Markdown text={content} /> : null}
      {notes.length ? (
        <div className={cn(content ? "mt-1 flex justify-end" : "flex items-center")}>
          <UserMessageAnnotationsBadge annotations={notes} />
        </div>
      ) : null}
    </div>
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
