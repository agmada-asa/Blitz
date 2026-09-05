"use client"

/** Renders active work and recent finished notifications with direct destinations. */

import Link from "next/link"
import {
  AlertCircleIcon,
  BubbleChatNotificationIcon,
  Download01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { useEffect } from "react"

import {
  type NotificationRow,
  useNotifications,
} from "@/components/notifications/notification-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { CheckCircleIcon, FileIcon, LoadingIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Maps notification kinds to a compact visual cue. */
function iconForKind(kind: NotificationRow["kind"]): IconSvgElement | null {
  switch (kind) {
    case "research":
      return Search01Icon
    case "import":
      return Download01Icon
    case "card-reply":
    case "workspace-reply":
      return BubbleChatNotificationIcon
    case "preparation":
      return null
  }
}

/** Formats a finished duration for compact metadata. */
function formatElapsed(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Formats a notification timestamp in the user's local time. */
function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

/** Renders the notification-kind icon or the shared source icon. */
function KindIcon({ row }: { row: NotificationRow }) {
  const icon = iconForKind(row.kind)
  if (row.status === "failed")
    return <HugeiconsIcon icon={AlertCircleIcon} size={20} strokeWidth={1.8} />
  if (row.status === "completed")
    return <CheckCircleIcon aria-hidden="true" size={20} />
  if (row.status === "running")
    return (
      <LoadingIcon
        aria-hidden="true"
        className="motion-safe:animate-spin"
        size={20}
      />
    )
  return icon ? (
    <HugeiconsIcon icon={icon} size={20} strokeWidth={1.8} />
  ) : (
    <FileIcon aria-hidden="true" size={20} />
  )
}

/** Renders one active task with a live duration and direct destination. */
function TaskRow({ row }: { row: NotificationRow }) {
  return (
    <Link
      href={row.href}
      aria-label={`${row.title}. ${row.detail}`}
      className="group block rounded-2xl border bg-card p-4 shadow-sm transition-colors hover:border-foreground/20 hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:p-5"
    >
      <article className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <KindIcon row={row} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.title}</span>
            <Badge variant="outline">{row.stage}</Badge>
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">
            {row.detail}
          </span>
          {row.context ? (
            <span className="mt-2 block text-xs text-muted-foreground">
              {row.context}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {row.elapsedSince ? (
            <ElapsedTime since={row.elapsedSince} />
          ) : (
            formatElapsed(row.elapsedMs)
          )}
        </span>
      </article>
    </Link>
  )
}

/** Renders one finished or failed item as an openable notification. */
function NotificationItem({ row }: { row: NotificationRow }) {
  return (
    <Link
      href={row.href}
      aria-label={`${row.title}. ${row.detail}`}
      className="group block rounded-xl px-3 py-3 transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-4"
    >
      <article className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
            row.status === "failed"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-foreground"
          )}
        >
          <KindIcon row={row} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{row.title}</span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {row.detail}
          </span>
          {row.error ? (
            <span className="mt-1 block text-sm text-destructive">
              {row.error}
            </span>
          ) : null}
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {row.context ? `${row.context} · ` : null}
            <time dateTime={new Date(row.updatedAt).toISOString()}>
              {formatTimestamp(row.updatedAt)}
            </time>
          </span>
        </span>
      </article>
    </Link>
  )
}

/** Displays notification permission status and requests browser alerts on click. */
function BrowserAlertControl() {
  const { browserPermission, requestBrowserNotifications } = useNotifications()
  if (browserPermission === "granted")
    return (
      <p className="text-sm text-muted-foreground">
        Browser alerts are on while Blitz is open.
      </p>
    )
  if (browserPermission === "denied")
    return (
      <p className="max-w-sm text-sm text-muted-foreground">
        Browser alerts are blocked. You can turn them on in your browser&apos;s
        site settings.
      </p>
    )
  if (browserPermission === "unsupported") return null
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 rounded-full"
      onClick={() => void requestBrowserNotifications()}
    >
      Turn on browser alerts
    </Button>
  )
}

/** Renders the full notification center and marks visible results as read. */
export function NotificationCenter() {
  const { snapshot, markAllRead } = useNotifications()

  useEffect(() => {
    if (snapshot) markAllRead()
  }, [markAllRead, snapshot])

  if (!snapshot)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading notifications…
      </p>
    )

  return (
    <div className="space-y-10">
      <section aria-labelledby="ongoing-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="ongoing-heading" className="font-heading text-xl">
              Ongoing
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Work continues when you move elsewhere in Blitz.
            </p>
          </div>
          {snapshot.tasks.length ? (
            <Badge variant="secondary">{snapshot.tasks.length} active</Badge>
          ) : null}
        </div>
        {snapshot.tasks.length ? (
          <div className="space-y-3">
            {snapshot.tasks.map((row) => (
              <TaskRow key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">
            No work is running right now.
          </div>
        )}
      </section>

      <section aria-labelledby="recent-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="recent-heading" className="font-heading text-xl">
              Recent
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Open a result to return to the chat, research plan, or project.
            </p>
          </div>
          <BrowserAlertControl />
        </div>
        {snapshot.notifications.length ? (
          <div className="divide-y rounded-2xl border bg-card">
            {snapshot.notifications.map((row) => (
              <NotificationItem key={row.id} row={row} />
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            Finished work and replies will appear here.
          </div>
        )}
      </section>
    </div>
  )
}
