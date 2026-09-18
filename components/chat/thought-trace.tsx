"use client"

/** Displays collapsible reasoning traces, provider tool activity, and agent requests in unified chronological order. */

import { useEffect, useMemo, useState } from "react"
import {
  ArrowDownIcon,
  ArrowRightIcon,
  LoadingIcon,
} from "@/components/ui/icon"
import { Markdown } from "@/components/ui/markdown"
import { AgentRequestPanel } from "@/components/chat/agent-request-panel"
import { ProviderActivityRow } from "@/components/chat/provider-activity"
import type { AgentRequest } from "@/lib/agent-request"
import type { ProviderActivityEvent } from "@/lib/provider-activity"
import { cn } from "@/lib/utils"

/** Formats elapsed seconds into human-readable duration strings (e.g. "0s", "14s", "2m 43s", "1h 12m"). */
export function formatDuration(seconds: number, isRunning = false): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  if (totalSeconds < 1) return isRunning ? "0s" : "<1s"
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const remSeconds = totalSeconds % 60
  if (totalSeconds < 3600) {
    return remSeconds > 0 ? `${minutes}m ${remSeconds}s` : `${minutes}m`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const remMinutes = Math.floor((totalSeconds % 3600) / 60)
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
}

/** Props accepted by the ThoughtTrace component. */
export interface ThoughtTraceProps {
  /** Reasoning or commentary text accumulated during the turn. */
  thought?: string | null
  /** Final turn duration in milliseconds, when available from the server. */
  durationMs?: number | null
  /** Message lifecycle status. */
  status?: "running" | "completed" | "failed"
  /** Epoch timestamp (ms) when the assistant message was created. */
  startedAt?: number
  /** Provider tool execution events occurring during this turn. */
  events?: readonly ProviderActivityEvent[]
  /** Provider requests (approvals, questions, forms) resolved during this turn. */
  requests?: readonly AgentRequest[]
  /** Additional container classes. */
  className?: string
}

type TimelineItem =
  | { kind: "thought"; id: string; text: string }
  | { kind: "events"; id: string; events: ProviderActivityEvent[] }
  | { kind: "request"; id: string; request: AgentRequest }

/** Renders an active or finished agent thought trace with tool activity and approvals in chronological order. */
export function ThoughtTrace({
  thought,
  durationMs,
  status,
  startedAt,
  events,
  requests,
  className,
}: ThoughtTraceProps) {
  const isRunning = status === "running"
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  // Ticks every second while the turn is actively running.
  useEffect(() => {
    if (!isRunning) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [isRunning])

  const timeline = useMemo<TimelineItem[]>(() => {
    type RawItem =
      | { kind: "thought"; id: string; text: string; timestamp: number }
      | {
          kind: "event"
          id: string
          event: ProviderActivityEvent
          timestamp: number
        }
      | { kind: "request"; id: string; request: AgentRequest; timestamp: number }

    const raw: RawItem[] = []

    if (thought && thought.trim()) {
      raw.push({
        kind: "thought",
        id: "thought",
        text: thought.trim(),
        timestamp: startedAt ?? 0,
      })
    }

    if (events && events.length > 0) {
      for (const evt of events) {
        raw.push({
          kind: "event",
          id: evt.id,
          event: evt,
          timestamp: evt.startedAt ?? evt.completedAt ?? ((startedAt ?? 0) + 1),
        })
      }
    }

    if (requests && requests.length > 0) {
      for (const req of requests) {
        raw.push({
          kind: "request",
          id: req.id,
          request: req,
          timestamp:
            req.createdAt ?? req.completedAt ?? ((startedAt ?? 0) + 2),
        })
      }
    }

    raw.sort((a, b) => a.timestamp - b.timestamp)

    const items: TimelineItem[] = []
    for (const item of raw) {
      if (item.kind === "event") {
        const last = items[items.length - 1]
        if (last && last.kind === "events") {
          last.events.push(item.event)
        } else {
          items.push({
            kind: "events",
            id: `events-${item.id}`,
            events: [item.event],
          })
        }
      } else {
        items.push(item)
      }
    }

    return items
  }, [thought, events, requests, startedAt])

  // If there are no timeline items and the turn is not running, don't render anything.
  if (timeline.length === 0 && !isRunning) {
    return null
  }

  const isExpanded = userToggled ?? isRunning

  // Calculate duration to display.
  let durationSeconds = 0
  if (typeof durationMs === "number" && durationMs >= 0) {
    durationSeconds = Math.round(durationMs / 1000)
  } else if (isRunning && startedAt) {
    durationSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  }

  const durationText = formatDuration(durationSeconds, isRunning)

  const toggleExpanded = () => {
    setUserToggled((current) => !(current ?? isRunning))
  }

  return (
    <div className={cn("mb-3 rounded-lg text-xs", className)}>
      {isRunning ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={timeline.length > 0 ? toggleExpanded : undefined}
            className={cn(
              "flex items-center gap-2 font-medium text-muted-foreground select-none",
              timeline.length > 0 &&
                "group cursor-pointer hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            )}
            aria-expanded={timeline.length > 0 ? isExpanded : undefined}
            aria-label={
              timeline.length > 0
                ? isExpanded
                  ? "Collapse working activity"
                  : "Expand working activity"
                : undefined
            }
          >
            <LoadingIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <span>Working for {durationText}</span>
            {timeline.length > 0 ? (
              isExpanded ? (
                <ArrowDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground" />
              ) : (
                <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground" />
              )
            ) : null}
          </button>
          {isExpanded && timeline.length > 0 ? (
            <div className="mt-1 flex flex-col gap-2.5 border-l-2 border-border/40 pl-3 leading-relaxed text-muted-foreground/80">
              {timeline.map((item) => {
                if (item.kind === "thought") {
                  return (
                    <div
                      key={item.id}
                      className="[&_.chat-markdown]:text-xs [&_.chat-markdown]:leading-relaxed [&_.chat-markdown_p]:text-muted-foreground/80 [&_.chat-markdown_pre]:text-[11px]"
                    >
                      <Markdown text={item.text} />
                    </div>
                  )
                }
                if (item.kind === "events") {
                  return (
                    <ul key={item.id} className="space-y-1">
                      {item.events.map((event) => (
                        <ProviderActivityRow key={event.id} event={event} />
                      ))}
                    </ul>
                  )
                }
                if (item.kind === "request") {
                  return (
                    <div key={item.id} className="my-0.5">
                      <AgentRequestPanel
                        request={item.request}
                        readOnly
                        className="p-2.5 text-xs"
                        onSubmit={() => undefined}
                      />
                    </div>
                  )
                }
                return null
              })}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={toggleExpanded}
            className="group inline-flex cursor-pointer items-center gap-1.5 rounded py-0.5 font-medium text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
            aria-expanded={isExpanded}
            aria-label={
              isExpanded ? "Collapse thought trace" : "Expand thought trace"
            }
          >
            <span>Worked for {durationText}</span>
            {isExpanded ? (
              <ArrowDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground" />
            ) : (
              <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground" />
            )}
          </button>
          {isExpanded && timeline.length > 0 ? (
            <div className="mt-1 flex flex-col gap-2.5 border-l-2 border-border/40 pl-3 leading-relaxed text-muted-foreground/80">
              {timeline.map((item) => {
                if (item.kind === "thought") {
                  return (
                    <div
                      key={item.id}
                      className="[&_.chat-markdown]:text-xs [&_.chat-markdown]:leading-relaxed [&_.chat-markdown_p]:text-muted-foreground/80 [&_.chat-markdown_pre]:text-[11px]"
                    >
                      <Markdown text={item.text} />
                    </div>
                  )
                }
                if (item.kind === "events") {
                  return (
                    <ul key={item.id} className="space-y-1">
                      {item.events.map((event) => (
                        <ProviderActivityRow key={event.id} event={event} />
                      ))}
                    </ul>
                  )
                }
                if (item.kind === "request") {
                  return (
                    <div key={item.id} className="my-0.5">
                      <AgentRequestPanel
                        request={item.request}
                        readOnly
                        className="p-2.5 text-xs"
                        onSubmit={() => undefined}
                      />
                    </div>
                  )
                }
                return null
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

