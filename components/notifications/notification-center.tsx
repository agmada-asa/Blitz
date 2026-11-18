"use client"

/**
 * Renders the notification center: a toolbar with the unread count and whether anything is
 * running, any ongoing work, then finished notifications grouped by day. Neighbouring "practice
 * questions ready" notifications fold into one line that opens to show each. Every row links to
 * where the work happened.
 */

import Link from "next/link"
import {
  AlertCircleIcon,
  BubbleChatNotificationIcon,
  Download01Icon,
  Mortarboard01Icon,
  PencilEdit02Icon,
  Quiz01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"

import {
  type NotificationRow,
  useNotifications,
} from "@/components/notifications/notification-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CheckIcon,
  FileIcon,
  LoadingIcon,
} from "@/components/ui/icon"
import { collapseRuns, groupByDay } from "@/lib/day-groups"
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
    case "practice":
      return Quiz01Icon
    case "exam-paper":
      return Mortarboard01Icon
    case "exam-marking":
      return PencilEdit02Icon
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

/** Formats a notification timestamp in the user's local time for full tooltips. */
function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)
}

/** Formats a timestamp into a compact relative or short calendar label. */
function formatCompactTimestamp(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp)
}

/** Renders the notification-kind icon or the shared source icon in compact dimensions. */
function KindIcon({ row }: { row: NotificationRow }) {
  const icon = iconForKind(row.kind)
  if (row.status === "failed")
    return <HugeiconsIcon icon={AlertCircleIcon} size={16} strokeWidth={1.8} />
  if (row.status === "completed")
    return <CheckCircleIcon aria-hidden="true" size={16} />
  if (row.status === "running")
    return (
      <LoadingIcon
        aria-hidden="true"
        className="motion-safe:animate-spin"
        size={16}
      />
    )
  return icon ? (
    <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} />
  ) : (
    <FileIcon aria-hidden="true" size={16} />
  )
}

/** Renders one active task with a live duration and direct destination in a compact card. */
function TaskRow({ row }: { row: NotificationRow }) {
  return (
    <Link
      href={row.href}
      aria-label={`${row.title}. ${row.detail}`}
      className="group block rounded-xl border bg-card px-3.5 py-2.5 shadow-2xs transition-colors hover:border-foreground/20 hover:bg-muted/35 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-4 sm:py-2.5"
    >
      <article className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
          <KindIcon row={row} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{row.title}</span>
            <Badge
              variant="outline"
              className="h-4 px-1.5 py-0 text-[10px] font-normal leading-none"
            >
              {row.stage}
            </Badge>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {row.context ? `${row.context} · ` : null}
            {row.detail}
          </span>
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

/** Props for rendering one terminal notification item with unread state. */
type NotificationItemProps = {
  row: NotificationRow
  unread: boolean
  onMarkRead: () => void
  onMarkUnread: () => void
  /** Indents the row under a collapsed run's summary line. */
  nested?: boolean
}

/** Renders one finished or failed item as an openable notification with compact unread cues. */
function NotificationItem({
  row,
  unread,
  onMarkRead,
  onMarkUnread,
  nested = false,
}: NotificationItemProps) {
  return (
    <article
      className={cn(
        "group relative flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 sm:py-3",
        nested && "pl-8 sm:pl-14",
        unread
          ? "bg-brand/[0.03] hover:bg-brand/[0.06] dark:bg-brand/[0.06] dark:hover:bg-brand/[0.09]"
          : "hover:bg-muted/60"
      )}
    >
      <Link
        href={row.href}
        onClick={onMarkRead}
        onAuxClick={(event) => {
          if (event.button === 1) onMarkRead()
        }}
        aria-label={`${row.title}${unread ? " (unread)" : ""}. ${row.detail}`}
        className="absolute inset-0 z-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="sr-only">
          {row.title}
          {unread ? " (unread)" : ""}. {row.detail}
        </span>
      </Link>

      <span
        className={cn(
          "pointer-events-none relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg",
          row.status === "failed"
            ? "bg-destructive/10 text-destructive"
            : unread
              ? "bg-brand/10 text-brand"
              : "bg-muted text-foreground"
        )}
      >
        <KindIcon row={row} />
        {unread ? (
          <span
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-background bg-brand"
            aria-hidden="true"
          />
        ) : null}
      </span>

      <div className="pointer-events-none relative z-10 min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "line-clamp-2 text-sm",
                unread
                  ? "font-semibold text-foreground"
                  : "font-medium text-foreground/90"
              )}
            >
              {row.title}
            </span>
            {row.context ? (
              <span className="hidden truncate text-xs text-muted-foreground/80 sm:inline">
                · {row.context}
              </span>
            ) : null}
          </div>

          <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">
            <time
              dateTime={new Date(row.updatedAt).toISOString()}
              title={formatTimestamp(row.updatedAt)}
              className="text-[11px] text-muted-foreground"
            >
              {formatCompactTimestamp(row.updatedAt)}
            </time>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn(
                "size-6 text-muted-foreground transition-opacity",
                unread
                  ? "opacity-80 hover:text-foreground hover:opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground"
              )}
              title={unread ? "Mark as read" : "Mark as unread"}
              aria-label={
                unread
                  ? `Mark "${row.title}" as read`
                  : `Mark "${row.title}" as unread`
              }
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (unread) {
                  onMarkRead()
                } else {
                  onMarkUnread()
                }
              }}
            >
              {unread ? (
                <CheckIcon aria-hidden="true" size={13} strokeWidth={2.2} />
              ) : (
                <span
                  className="size-1.5 rounded-full border border-muted-foreground/60 transition-colors hover:border-brand hover:bg-brand/30"
                  aria-hidden="true"
                />
              )}
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {row.context ? (
            <span className="truncate sm:hidden">{row.context} · </span>
          ) : null}
          <p className="truncate">
            {row.error ? (
              <span className="text-destructive">{row.error}</span>
            ) : (
              row.detail
            )}
          </p>
        </div>
      </div>
    </article>
  )
}

/**
 * Returns the key that lets neighbouring notifications fold into one line. Only finished
 * "practice questions ready" rows fold; everything else stays on its own line.
 * @param row A finished or failed notification.
 */
function runKey(row: NotificationRow): string | null {
  return row.kind === "practice" && row.status === "completed"
    ? "practice-ready"
    : null
}

/** Props for one folded run of "practice questions ready" notifications. */
type NotificationRunProps = {
  rows: NotificationRow[]
  isRead: (id: string) => boolean
  markAsRead: (id: string) => void
  markAsUnread: (id: string) => void
}

/**
 * Shows a run of "practice questions ready" notifications as one line with the unit count,
 * the total questions and the projects involved. Opening it lists each notification with its
 * own link and read control. The line counts as unread while any notification in it is.
 */
function NotificationRun({
  rows,
  isRead,
  markAsRead,
  markAsUnread,
}: NotificationRunProps) {
  const unreadRows = rows.filter((row) => !isRead(row.id))
  const unread = unreadRows.length > 0
  const questions = rows.reduce(
    (total, row) => total + (row.generatedItemCount ?? 0),
    0
  )
  const projects = [
    ...new Set(rows.map((row) => row.context).filter(Boolean)),
  ].join(", ")
  const newest = rows[0]
  // A unit can finish more than one run, so count units by their distinct titles.
  const unitCount = new Set(rows.map((row) => row.title)).size
  const title =
    unitCount === 1
      ? newest.title
      : `Practice questions ready for ${unitCount} units`
  const detail = [
    questions ? `${questions} ${questions === 1 ? "question" : "questions"}` : null,
    projects || null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Collapsible className="group/run">
      <div
        className={cn(
          "relative flex items-center gap-3 px-3 py-2.5 transition-colors sm:px-4 sm:py-3",
          unread
            ? "bg-brand/[0.03] hover:bg-brand/[0.06] dark:bg-brand/[0.06] dark:hover:bg-brand/[0.09]"
            : "hover:bg-muted/60"
        )}
      >
        <CollapsibleTrigger className="absolute inset-0 z-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <span className="sr-only">
            {title}
            {unread ? " (unread)" : ""}. {detail}
          </span>
        </CollapsibleTrigger>
        <span
          className={cn(
            "pointer-events-none relative z-10 flex size-8 shrink-0 items-center justify-center rounded-lg",
            unread ? "bg-brand/10 text-brand" : "bg-muted text-foreground"
          )}
        >
          <CheckCircleIcon aria-hidden="true" size={16} />
          {unread ? (
            <span
              className="absolute -top-0.5 -right-0.5 size-2 rounded-full border border-background bg-brand"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <div className="pointer-events-none relative z-10 min-w-0 flex-1">
          <p
            className={cn(
              "line-clamp-2 text-sm",
              unread
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/90"
            )}
          >
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1.5">
          <time
            dateTime={new Date(newest.updatedAt).toISOString()}
            title={formatTimestamp(newest.updatedAt)}
            className="pointer-events-none text-[11px] text-muted-foreground"
          >
            {formatCompactTimestamp(newest.updatedAt)}
          </time>
          {unread ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6 text-muted-foreground opacity-80 hover:text-foreground hover:opacity-100"
              title="Mark these as read"
              aria-label={`Mark ${rows.length} practice notifications as read`}
              onClick={() => unreadRows.forEach((row) => markAsRead(row.id))}
            >
              <CheckIcon aria-hidden="true" size={13} strokeWidth={2.2} />
            </Button>
          ) : null}
          <ArrowRightIcon
            aria-hidden="true"
            size={14}
            className="pointer-events-none text-muted-foreground transition-transform group-data-[state=open]/run:rotate-90 motion-reduce:transition-none"
          />
        </div>
      </div>
      <CollapsibleContent className="divide-y border-t">
        {rows.map((row) => (
          <NotificationItem
            key={row.id}
            row={row}
            nested
            unread={!isRead(row.id)}
            onMarkRead={() => markAsRead(row.id)}
            onMarkUnread={() => markAsUnread(row.id)}
          />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Displays notification permission status and requests browser alerts on click. */
function BrowserAlertControl() {
  const { browserPermission, requestBrowserNotifications } = useNotifications()
  if (browserPermission === "granted")
    return (
      <p className="text-xs text-muted-foreground">
        Browser alerts on
      </p>
    )
  if (browserPermission === "denied")
    return (
      <p className="max-w-xs text-xs text-muted-foreground">
        Browser alerts blocked in site settings
      </p>
    )
  if (browserPermission === "unsupported") return null
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 rounded-full px-2.5 text-xs"
      onClick={() => void requestBrowserNotifications()}
    >
      Turn on alerts
    </Button>
  )
}

/** Renders the full notification center without auto-clearing unread state on mount. */
export function NotificationCenter() {
  const {
    snapshot,
    unreadCount,
    isRead,
    markAsRead,
    markAsUnread,
    markAllRead,
  } = useNotifications()
  // Ticks each minute, so a page left open past midnight moves items under Yesterday.
  const now = useMinuteClock()

  if (!snapshot)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading notifications…
      </p>
    )

  const dayGroups = groupByDay(snapshot.notifications, (row) => row.updatedAt, now)

  return (
    <div className="space-y-6">
      {/* One toolbar: unread count, whether anything is running, and the page actions. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {unreadCount > 0 ? (
          <Badge
            variant="secondary"
            className="gap-1 px-2 py-0.5 text-[11px] font-normal"
          >
            <span className="size-1.5 rounded-full bg-brand" aria-hidden="true" />
            {unreadCount} unread
          </Badge>
        ) : null}
        {snapshot.tasks.length ? null : (
          <p className="text-xs text-muted-foreground">
            Nothing running right now
          </p>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <BrowserAlertControl />
          {unreadCount > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-2.5 text-xs"
              onClick={markAllRead}
            >
              Mark all as read
            </Button>
          ) : null}
        </div>
      </div>

      {snapshot.tasks.length ? (
        <section aria-labelledby="ongoing-heading">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 id="ongoing-heading" className="text-sm font-medium">
              Ongoing
            </h2>
            <p className="text-xs text-muted-foreground">
              Work continues when you move elsewhere in Blitz.
            </p>
          </div>
          <div className="space-y-2">
            {snapshot.tasks.map((row) => (
              <TaskRow key={row.id} row={row} />
            ))}
          </div>
        </section>
      ) : null}

      {dayGroups.length ? (
        dayGroups.map((group) => {
          const headingId = `notifications-${group.label.replace(/\s+/g, "-").toLowerCase()}`
          return (
            <section key={group.label} aria-labelledby={headingId}>
              <h2
                id={headingId}
                className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                {group.label}
              </h2>
              <div className="divide-y overflow-hidden rounded-2xl border bg-card">
                {collapseRuns(group.items, runKey).map((entry) =>
                  entry.type === "run" ? (
                    <NotificationRun
                      key={entry.items[0].id}
                      rows={entry.items}
                      isRead={isRead}
                      markAsRead={markAsRead}
                      markAsUnread={markAsUnread}
                    />
                  ) : (
                    <NotificationItem
                      key={entry.item.id}
                      row={entry.item}
                      unread={!isRead(entry.item.id)}
                      onMarkRead={() => markAsRead(entry.item.id)}
                      onMarkUnread={() => markAsUnread(entry.item.id)}
                    />
                  )
                )}
              </div>
            </section>
          )
        })
      ) : (
        <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          Finished work and replies will appear here.
        </p>
      )}
    </div>
  )
}
