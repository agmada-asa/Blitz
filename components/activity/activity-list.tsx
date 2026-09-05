"use client"

/** Renders durable preparation activity and links each row back to its project. */

import Link from "next/link"
import { useQuery } from "convex/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { FileIcon, LoadingIcon, RotateLeftIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"

/** Formats a duration for compact activity metadata. */
function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Displays active and failed jobs returned by the bounded activity query. */
export function ActivityList() {
  const activity = useQuery(api.activity.list)
  if (activity === undefined) {
    return <p className="text-sm text-muted-foreground">Loading activity…</p>
  }
  if (!activity.jobs.length) {
    return (
      <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        Nothing needs your attention yet.
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {activity.jobs.map((job) => (
        <article
          key={job.jobId}
          className="rounded-2xl border bg-card p-4 shadow-sm sm:p-5"
        >
          <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
              {job.status === "leased" || job.status === "running" ? (
                <LoadingIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                  size={20}
                />
              ) : job.status === "failed" ? (
                <RotateLeftIcon aria-hidden="true" size={20} />
              ) : (
                <FileIcon aria-hidden="true" size={20} />
              )}
            </div>
            <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-auto">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate font-medium">{job.label}</h2>
                <Badge
                  variant={job.status === "failed" ? "destructive" : "outline"}
                >
                  {job.status === "leased" || job.status === "running"
                    ? "Running"
                    : job.status === "completed"
                      ? "Ready"
                      : job.status === "queued"
                        ? "Queued"
                        : "Failed"}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {job.projectTitle}
              </p>
              <p className="mt-2 text-sm">
                {job.stage} ·{" "}
                {job.elapsedSince ? (
                  <ElapsedTime since={job.elapsedSince} />
                ) : (
                  formatElapsed(job.elapsedMs)
                )}
              </p>
              {job.generatedItemCount !== null && job.generatedItemCount > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {job.generatedItemCount}{" "}
                  {job.generatedItemCount === 1 ? "item" : "items"} generated
                </p>
              ) : null}
              {job.error ? (
                <p className="mt-2 text-sm text-destructive">{job.error}</p>
              ) : null}
            </div>
            <Button asChild variant="ghost" size="sm" className="shrink-0">
              <Link href={job.href ?? `/projects/${job.projectId}`}>
                {job.kind === "chat" ? "Open chat" : "Open project"}
              </Link>
            </Button>
          </div>
        </article>
      ))}
    </div>
  )
}
