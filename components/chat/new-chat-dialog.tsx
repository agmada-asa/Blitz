"use client"

/** Lets a learner choose or create the project that will own a new chat. */

import { useState } from "react"
import { Folder01Icon, PlusSignIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { LoadingIcon } from "@/components/ui/icon"
import type { Id } from "@/convex/_generated/dataModel"

/** Minimal project metadata needed by the new-chat picker. */
export type NewChatProject = {
  _id: Id<"projects">
  title: string
}

/** Controlled inputs and project actions for the new-chat picker. */
type NewChatDialogProps = {
  open: boolean
  projects?: NewChatProject[]
  onOpenChange: (open: boolean) => void
  onSelect: (project: NewChatProject) => void
  onCreate: (title: string) => Promise<NewChatProject>
}

/** Shows project selection first and an inline project form when requested. */
export function NewChatDialog({
  open,
  projects,
  onOpenChange,
  onSelect,
  onCreate,
}: NewChatDialogProps) {
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  /** Resets local form state before handing a project back to the workspace. */
  const selectProject = (project: NewChatProject): void => {
    setCreating(false)
    setTitle("")
    setError("")
    onSelect(project)
  }

  /** Creates and immediately selects a project without leaving the chat flow. */
  const createAndSelect = async (): Promise<void> => {
    const projectTitle = title.trim()
    if (!projectTitle || submitting) return
    setSubmitting(true)
    setError("")
    try {
      const project = await onCreate(projectTitle)
      selectProject(project)
    } catch {
      setError("Could not create that project. Try again.")
    } finally {
      setSubmitting(false)
    }
  }

  /** Prevents the dialog from closing while project creation is in flight. */
  const changeOpen = (nextOpen: boolean): void => {
    if (submitting) return
    if (!nextOpen) {
      setCreating(false)
      setTitle("")
      setError("")
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        showCloseButton={!submitting}
        aria-describedby="new-chat-description"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription id="new-chat-description">
            Choose the project this chat belongs to.
          </DialogDescription>
        </DialogHeader>

        {creating ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void createAndSelect()
            }}
          >
            <div className="grid gap-2">
              <label htmlFor="new-chat-project-name" className="font-medium">
                Project name
              </label>
              <Input
                id="new-chat-project-name"
                autoFocus
                maxLength={200}
                value={title}
                disabled={submitting}
                placeholder="e.g. Cognitive science"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={submitting}
                onClick={() => {
                  setCreating(false)
                  setTitle("")
                  setError("")
                }}
              >
                Back
              </Button>
              <Button
                type="submit"
                className="h-11 bg-brand text-brand-foreground hover:bg-brand/85"
                disabled={!title.trim() || submitting}
              >
                {submitting ? (
                  <>
                    <LoadingIcon className="animate-spin motion-reduce:animate-none" />
                    Creating…
                  </>
                ) : (
                  "Create and start chat"
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <div className="-mx-1 max-h-72 space-y-1 overflow-y-auto p-1">
              {projects === undefined ? (
                <p
                  role="status"
                  className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
                >
                  <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
                  Loading projects…
                </p>
              ) : projects.length ? (
                projects.map((project) => (
                  <Button
                    key={project._id}
                    type="button"
                    variant="ghost"
                    className="h-auto w-full justify-start gap-3 rounded-xl px-3 py-3 text-left"
                    onClick={() => selectProject(project)}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={18}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {project.title}
                    </span>
                  </Button>
                ))
              ) : (
                <p className="p-4 text-sm text-muted-foreground">
                  Create your first project to start a chat.
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full justify-start gap-2"
              disabled={projects === undefined}
              onClick={() => setCreating(true)}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={18} aria-hidden="true" />
              Create a new project
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
