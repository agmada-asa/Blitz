"use client"

/** Renders compact, bounded provider tool activity without exposing raw tool payloads. */
import type { ProviderActivityEvent } from "@/lib/provider-activity"

/** Shows one provider tool lifecycle timeline beside an assistant response. */
export function ProviderActivity({
  events,
}: {
  events: readonly ProviderActivityEvent[]
}) {
  if (!events.length) return null
  return (
    <details className="mb-3 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        Activity ({events.length})
      </summary>
      <ul className="mt-2 space-y-1 border-l border-border/60 pl-3">
        {events.map((event) => (
          <li key={event.id} className="flex min-w-0 items-baseline gap-2">
            <span
              className={
                event.status === "failed"
                  ? "text-destructive"
                  : event.status === "running"
                    ? "text-brand"
                    : "text-muted-foreground"
              }
              aria-hidden="true"
            >
              {event.status === "running"
                ? "•"
                : event.status === "failed"
                  ? "×"
                  : "✓"}
            </span>
            <span className="sr-only">{event.status}: </span>
            <span className="min-w-0 truncate" title={event.detail}>
              {event.title}
            </span>
          </li>
        ))}
      </ul>
    </details>
  )
}
