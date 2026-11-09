"use client"

/**
 * Tells the learner, at the top of a lesson, that files have arrived since it
 * was planned, and offers to update it. Also shows the update running and why
 * one failed. It sits in the header, not the lesson's bottom bar, which stays a
 * single action that moves the lesson along.
 */

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Props for the update notice. */
type TeachUpdateNoticeProps = {
  /** Readable files the lesson has not seen. */
  newFileCount: number
  /** Files the running update is reading. */
  runningFileCount: number
  /** An update is under way. */
  running: boolean
  /** Why the last update failed, or why it could not start. */
  error: string | null
  /** A reply is being written, so the update has to wait. */
  blocked: boolean
  /** The request to start an update is on its way. */
  starting: boolean
  onUpdate: () => void
  className?: string
}

/** Words a count of new files. */
function files(count: number): string {
  return `${count} new file${count === 1 ? "" : "s"}`
}

/**
 * Renders the notice for the lesson's update state, or nothing when the lesson
 * is up to date and no update has failed.
 */
export function TeachUpdateNotice({
  newFileCount,
  runningFileCount,
  running,
  error,
  blocked,
  starting,
  onUpdate,
  className,
}: TeachUpdateNoticeProps) {
  if (running)
    return (
      <p
        role="status"
        className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}
      >
        <LoadingIcon aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
        Updating this lesson from {files(runningFileCount || newFileCount)}…
      </p>
    )
  if (!newFileCount && !error) return null
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      <p
        role={error ? "alert" : undefined}
        className={cn("min-w-0 flex-1 basis-56 text-sm", error ? "text-destructive" : "text-muted-foreground")}
      >
        {error ?? `${files(newFileCount)} ${newFileCount === 1 ? "isn't" : "aren't"} in this lesson yet.`}
      </p>
      {newFileCount ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked || starting}
          onClick={onUpdate}
          className="min-h-9 shrink-0 rounded-full px-4"
        >
          {error ? "Try again" : "Update lesson"}
        </Button>
      ) : null}
    </div>
  )
}
