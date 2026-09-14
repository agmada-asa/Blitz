"use client"

/** Owns the anchored numbered chip and expandable small textarea bubble for one annotation. */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Delete02Icon, Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Button } from "@/components/ui/button"
import { CancelIcon } from "@/components/ui/icon"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/** Annotation model rendered as an anchored floating chip on a model reply. */
export type FloatingAnnotation = {
  id: string
  number: number
  messageId: string
  selectedText: string
  note: string
  createdAt?: number
  isDraft?: boolean
}

/** Properties for positioning, expanding, editing, and displaying one floating annotation chip. */
interface FloatingAnnotationChipProps {
  annotation: FloatingAnnotation
  position: { left: number; top: number }
  isExpanded: boolean
  isReadOnly?: boolean
  onToggleExpand: (id: string) => void
  onSave?: (id: string, note: string) => void
  onDelete?: (id: string) => void
}

/** Renders a floating numbered chip that expands into a small textarea card or read-only bubble. */
export function FloatingAnnotationChip({
  annotation,
  position,
  isExpanded,
  isReadOnly = false,
  onToggleExpand,
  onSave,
  onDelete,
}: FloatingAnnotationChipProps) {
  const readOnly = isReadOnly || annotation.isDraft === false
  const [draftNote, setDraftNote] = useState(annotation.note)
  const [prevPropNote, setPrevPropNote] = useState(annotation.note)
  const cardRef = useRef<HTMLDivElement>(null)

  if (prevPropNote !== annotation.note) {
    setPrevPropNote(annotation.note)
    setDraftNote(annotation.note)
  }

  /** Commits the edited note and collapses the bubble, or auto-deletes if empty. */
  const handleSave = (): void => {
    if (readOnly) return
    const trimmed = draftNote.trim()
    if (!trimmed) {
      onDelete?.(annotation.id)
    } else {
      onSave?.(annotation.id, trimmed)
    }
  }

  /** Handles closing the bubble. Auto-deletes empty draft annotations. */
  const handleDismiss = useCallback((): void => {
    if (readOnly) {
      onToggleExpand(annotation.id)
      return
    }
    const trimmed = draftNote.trim()
    if (!trimmed) {
      onDelete?.(annotation.id)
    } else if (trimmed !== annotation.note) {
      onSave?.(annotation.id, trimmed)
    } else {
      onToggleExpand(annotation.id)
    }
  }, [
    readOnly,
    draftNote,
    annotation.id,
    annotation.note,
    onToggleExpand,
    onDelete,
    onSave,
  ])

  /** Collapses the expanded bubble on Escape or clicks outside the card. */
  useEffect(() => {
    if (!isExpanded) return
    const handleClickOutside = (event: MouseEvent): void => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) {
        handleDismiss()
      }
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (readOnly) {
          onToggleExpand(annotation.id)
          return
        }
        const trimmed = draftNote.trim()
        if (!trimmed || !annotation.note.trim()) {
          onDelete?.(annotation.id)
        } else {
          setDraftNote(annotation.note)
          onToggleExpand(annotation.id)
        }
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    document.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
      document.removeEventListener("keydown", handleKeyDown)
    }
  }, [
    isExpanded,
    annotation.id,
    annotation.note,
    draftNote,
    readOnly,
    handleDismiss,
    onToggleExpand,
    onDelete,
  ])

  /** Saves on Enter (without Shift) or Cmd/Ctrl+Enter, keeping Shift+Enter for newlines. */
  const handleTextareaKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (event.key === "Enter") {
      if (event.shiftKey) {
        // Shift+Enter creates a new line in the textarea
        return
      }
      event.preventDefault()
      handleSave()
    }
  }

  return (
    <div
      className="absolute z-20 pointer-events-auto"
      style={{
        left: `${position.left}px`,
        top: `${position.top}px`,
      }}
    >
      {/* Collapsed small numbered badge */}
      <button
        type="button"
        aria-label={`Annotation ${annotation.number}: ${annotation.note || (readOnly ? "Annotation" : "Add note")}`}
        aria-expanded={isExpanded}
        className={cn(
          "-translate-x-1/2 -translate-y-1/2 flex size-5.5 items-center justify-center rounded-full text-[11px] font-bold shadow-xs transition-all duration-150 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          isExpanded
            ? "bg-brand text-brand-foreground scale-110 ring-2 ring-brand/40"
            : "bg-brand text-brand-foreground hover:brightness-110 hover:scale-115"
        )}
        onClick={(event) => {
          event.stopPropagation()
          if (isExpanded) {
            handleDismiss()
          } else {
            onToggleExpand(annotation.id)
          }
        }}
      >
        {annotation.number}
      </button>

      {/* Expanded small card / text display bubble */}
      {isExpanded ? (
        <div
          ref={cardRef}
          role="dialog"
          aria-label={`Annotation ${annotation.number}`}
          className="absolute left-0 top-3 z-30 w-72 sm:w-80 rounded-xl border border-border bg-card p-3 shadow-xl text-xs text-card-foreground animate-in fade-in-0 zoom-in-95 duration-150"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between pb-1.5 border-b border-border/60">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <span className="flex size-4.5 items-center justify-center rounded-full bg-brand text-[10px] font-bold text-brand-foreground">
                {annotation.number}
              </span>
              <span>Annotation {annotation.number}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {readOnly ? "Read only" : "Draft"}
              </span>
              <button
                type="button"
                aria-label="Close annotation bubble"
                className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={handleDismiss}
              >
                <CancelIcon className="size-3" />
              </button>
            </div>
          </div>

          {annotation.selectedText ? (
            <blockquote className="mt-2.5 max-h-20 overflow-y-auto rounded bg-muted/40 p-2 text-muted-foreground italic border-l-2 border-brand/60 text-[11px] leading-relaxed">
              &ldquo;{annotation.selectedText}&rdquo;
            </blockquote>
          ) : null}

          {readOnly ? (
            <div className="mt-2.5 max-h-48 overflow-y-auto whitespace-pre-wrap text-foreground leading-relaxed">
              {annotation.note}
            </div>
          ) : (
            <div className="mt-2.5 space-y-2">
              <Textarea
                autoFocus
                rows={2}
                maxLength={4_000}
                value={draftNote}
                placeholder="Type your note, question, or correction…"
                className="min-h-[64px] max-h-40 resize-y text-xs border-input bg-background"
                onChange={(event) => setDraftNote(event.target.value)}
                onKeyDown={handleTextareaKeyDown}
              />
              <div className="flex items-center justify-between pt-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive text-xs gap-1"
                  onClick={() => onDelete?.(annotation.id)}
                >
                  <HugeiconsIcon icon={Delete02Icon} size={13} />
                  Delete
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs gap-1 bg-brand hover:brightness-110 text-brand-foreground font-medium"
                  onClick={handleSave}
                >
                  <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
