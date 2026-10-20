"use client"

/** Shares the project menu: rename, archive and confirmed deletion, used by the library cards and the project page. */

import { useRef, useState } from "react"
import { useMutation } from "convex/react"
import { ConvexError } from "convex/values"
import { useRouter } from "next/navigation"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useBackgroundNotice } from "@/components/background-notices"
import { Button } from "@/components/ui/button"
import { isArchived } from "@/lib/projects"
import { Input } from "@/components/ui/input"
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

/**
 * Opens project actions, reports mutation failures, and returns to the library after deletion when requested.
 * Archive and restore run at once without a dialog because they are reversible; a failure shows a background notice.
 */
export function ProjectActions({
  project,
  returnToLibrary = false,
}: {
  project: { _id: string; title: string; archivedAt?: number }
  returnToLibrary?: boolean
}) {
  const router = useRouter()
  const rename = useMutation(api.projects.renameProject)
  const remove = useMutation(api.projects.deleteProject)
  const setArchived = useMutation(api.projects.setProjectArchived)
  const notify = useBackgroundNotice()
  const trigger = useRef<HTMLButtonElement>(null)
  const [action, setAction] = useState<"rename" | "delete" | null>(null)
  const [title, setTitle] = useState(project.title)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  /** Archives an active project or restores an archived one; reports failure without changing the dialog state. */
  async function toggleArchive() {
    const archive = !isArchived(project)
    try {
      await setArchived({ projectId: project._id as Id<"projects">, archived: archive })
    } catch {
      notify(`Could not ${archive ? "archive" : "unarchive"} “${project.title}”. Try again.`)
    }
  }

  /** Opens a fresh form with the latest persisted project title. */
  function open(next: "rename" | "delete") {
    setTitle(project.title)
    setError("")
    setAction(next)
  }

  /** Saves the selected action once; keeps the dialog open when the server rejects it. */
  async function submit() {
    if (pending || !action) return
    setPending(true)
    setError("")
    try {
      const projectId = project._id as Id<"projects">
      if (action === "rename") await rename({ projectId, title: title.trim() })
      else await remove({ projectId })
      setAction(null)
      if (action === "delete" && returnToLibrary) router.replace("/")
    } catch (cause) {
      setError(
        cause instanceof ConvexError && typeof cause.data === "string"
          ? cause.data
          : `Could not ${action} this project. Try again.`
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={trigger}
            variant="ghost"
            size="icon"
            className="size-11 rounded-full text-muted-foreground"
            aria-label={`Actions for ${project.title}`}
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ⋯
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => open("rename")}>
            Rename project
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void toggleArchive()}>
            {isArchived(project) ? "Unarchive project" : "Archive project"}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => open("delete")}
          >
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={action !== null}
        onOpenChange={(next) => {
          if (!next && !pending) setAction(null)
        }}
      >
        <DialogContent
          aria-describedby={
            action === "delete"
              ? `delete-description-${project._id}`
              : undefined
          }
          showCloseButton={!pending}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {action === "delete" ? "Delete project?" : "Rename project"}
            </DialogTitle>
            {action === "delete" && (
              <DialogDescription
                id={`delete-description-${project._id}`}
                className="break-words"
              >{`This permanently deletes “${project.title}”, its sources, study content, conversations, and study history. This cannot be undone.`}</DialogDescription>
            )}
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            className="grid gap-4"
          >
            {action === "rename" && (
              <div className="grid gap-2">
                <label
                  htmlFor={`rename-${project._id}`}
                  className="font-medium"
                >
                  Project name
                </label>
                <Input
                  id={`rename-${project._id}`}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  disabled={pending}
                  autoFocus
                  className="h-11"
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                autoFocus={action === "delete"}
                disabled={pending}
                onClick={() => setAction(null)}
                className="h-11"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={action === "delete" ? "destructive" : "default"}
                disabled={
                  pending ||
                  (action === "rename" &&
                    (!title.trim() || title.trim() === project.title))
                }
                className="h-11"
              >
                {pending
                  ? action === "delete"
                    ? "Deleting…"
                    : "Saving…"
                  : action === "delete"
                    ? "Delete project"
                    : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
