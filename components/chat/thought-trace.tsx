"use client"

/** Displays collapsible reasoning traces and active working timers modeled after Codex. */

import { useEffect, useState } from "react"
import {
  ArrowDownIcon,
  ArrowRightIcon,
  LoadingIcon,
} from "@/components/ui/icon"
import { Markdown } from "@/components/ui/markdown"
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
  /** Additional container classes. */
  className?: string
}

/** Renders an active or finished agent thought trace with duration and accordion toggle. */
export function ThoughtTrace({
  thought,
  durationMs,
  status,
  startedAt,
  className,
}: ThoughtTraceProps) {
  const isRunning = status === "running"
  const [isOpen, setIsOpen] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())

  // Ticks every second while the turn is actively running.
  useEffect(() => {
    if (!isRunning) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [isRunning])

  const hasThought = Boolean(thought && thought.trim())

  // If there's no thought and the turn is not running, don't render anything.
  if (!hasThought && !isRunning) {
    return null
  }

  const isExpanded = isRunning || isOpen

  // Calculate duration to display.
  let durationSeconds = 0
  if (typeof durationMs === "number" && durationMs >= 0) {
    durationSeconds = Math.round(durationMs / 1000)
  } else if (isRunning && startedAt) {
    durationSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  }

  const durationText = formatDuration(durationSeconds, isRunning)

  return (
    <div className={cn("mb-3 rounded-lg text-xs", className)}>
      {isRunning ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 font-medium text-muted-foreground select-none">
            <LoadingIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <span>Working for {durationText}</span>
          </div>
          <div className="border-t border-border/40" />
          {hasThought ? (
            <div className="border-l-2 border-border/40 pl-2 leading-relaxed text-muted-foreground/80 [&_.chat-markdown]:text-xs [&_.chat-markdown]:leading-relaxed [&_.chat-markdown_p]:text-muted-foreground/80 [&_.chat-markdown_pre]:text-[11px]">
              <Markdown text={thought!} />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setIsOpen((current) => !current)}
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
          {isExpanded && hasThought ? (
            <div className="mt-1 border-l-2 border-border/40 pl-2 leading-relaxed text-muted-foreground/80 [&_.chat-markdown]:text-xs [&_.chat-markdown]:leading-relaxed [&_.chat-markdown_p]:text-muted-foreground/80 [&_.chat-markdown_pre]:text-[11px]">
              <Markdown text={thought!} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
