"use client"

/** Renders compact, bounded provider tool activity without exposing raw tool payloads. */
import type { ProviderActivityEvent } from "@/lib/provider-activity"
import { cn } from "@/lib/utils"

/** Renders a single tool execution row with status icon, action title, and code pill detail. */
export function ProviderActivityRow({
  event,
}: {
  event: ProviderActivityEvent
}) {
  return (
    <li className="flex min-w-0 items-start gap-2 py-0.5">
      <span
        className={cn(
          "mt-0.5 shrink-0 font-mono text-[11px]",
          event.status === "failed"
            ? "text-destructive"
            : event.status === "running"
              ? "text-brand"
              : "text-muted-foreground"
        )}
        aria-hidden="true"
      >
        {event.status === "running"
          ? "•"
          : event.status === "failed"
            ? "×"
            : "✓"}
      </span>
      <span className="sr-only">{event.status}: </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-medium text-foreground/85">{event.title}</span>
          {event.detail ? (
            <code
              className="rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground/75 break-all"
              title={event.detail}
            >
              {event.detail}
            </code>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/** Shows one provider tool lifecycle timeline beside an assistant response. */
export function ProviderActivity({
  events,
}: {
  events: readonly ProviderActivityEvent[]
}) {
  if (!events.length) return null
  return (
    <details className="mb-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
        Activity ({events.length})
      </summary>
      <ul className="mt-2 space-y-1.5 border-l border-border/60 pl-3">
        {events.map((event) => (
          <ProviderActivityRow key={event.id} event={event} />
        ))}
      </ul>
    </details>
  )
}
