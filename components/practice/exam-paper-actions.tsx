"use client"

/**
 * The actions menu for one exam paper, shared by the Exam prep list and the
 * paper's own page: a link to edit its questions and a confirmed deletion.
 * Deleting is refused while the paper is being prepared or an attempt is
 * being marked, and the dialog says why instead of offering the button.
 */

import Link from "next/link"
import { useMutation } from "convex/react"
import { ConvexError } from "convex/values"
import { useRef, useState } from "react"

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
import { LoadingIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { EXAM_CHANGE_LOCK_MESSAGES, type ExamChangeLock } from "@/lib/exam-scoring"

/** What the menu needs to know about a paper. */
export type ExamPaperActionTarget = {
  id: Id<"examPapers">
  title: string
  status: "processing" | "ready" | "failed"
  /** Why the paper can't be changed right now, if anything. */
  changeLock: ExamChangeLock | null
  /** Whether an attempt has been started and not submitted. */
  hasOpenAttempt: boolean
}

/**
 * Renders the "⋯" menu with Edit questions (ready papers only) and Delete
 * paper, and the confirmation dialog for deleting.
 * @param editHref Link to the paper's question editor.
 * @param onDeleted Called once the paper is deleted, such as to leave its page.
 */
export function ExamPaperActions({
  paper,
  editHref,
  onDeleted,
}: {
  paper: ExamPaperActionTarget
  editHref: string
  onDeleted?: () => void
}) {
  const deletePaper = useMutation(api.exam.deletePaper)
  const trigger = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState("")
  const descriptionId = `delete-paper-${paper.id}`

  /** Deletes the paper once; keeps the dialog open with the reason when the server refuses. */
  async function confirmDelete() {
    if (deleting || paper.changeLock) return
    setDeleting(true)
    setError("")
    try {
      await deletePaper({ paperId: paper.id })
      setConfirming(false)
      onDeleted?.()
    } catch (cause) {
      setError(
        cause instanceof ConvexError && typeof cause.data === "string"
          ? cause.data
          : "The paper could not be deleted. Try again."
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 rounded-full text-muted-foreground"
            aria-label={`Actions for ${paper.title}`}
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ⋯
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {paper.status === "ready" ? (
            <DropdownMenuItem asChild>
              <Link href={editHref}>Edit questions</Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => {
              setError("")
              setConfirming(true)
            }}
          >
            Delete paper
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!next && !deleting) setConfirming(false)
        }}
      >
        <DialogContent
          aria-describedby={descriptionId}
          showCloseButton={!deleting}
          onCloseAutoFocus={(event) => {
            // The menu item that opened the dialog is gone, so return focus to the menu button.
            event.preventDefault()
            trigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete this paper?</DialogTitle>
            <DialogDescription id={descriptionId} className="break-words">
              {`“${paper.title}” and all its attempts and marks are removed${paper.hasOpenAttempt ? ", including the attempt you haven't submitted" : ""}. Answers you already gave still count toward your concept strengths. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          {paper.changeLock ? (
            <p role="status" className="text-sm text-muted-foreground">
              {EXAM_CHANGE_LOCK_MESSAGES[paper.changeLock]}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              disabled={deleting}
              onClick={() => setConfirming(false)}
              className="min-h-11 rounded-full px-5"
            >
              {paper.changeLock ? "Close" : "Keep paper"}
            </Button>
            {paper.changeLock ? null : (
              <Button
                type="button"
                variant="destructive"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="min-h-11 rounded-full px-5"
              >
                {deleting ? (
                  <>
                    <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Deleting
                  </>
                ) : (
                  "Delete paper"
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
