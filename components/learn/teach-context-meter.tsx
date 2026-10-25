"use client"

/**
 * The quiet context meter in the Teach header and the sheet it opens.
 *
 * The meter shows how full the session's model context is after the last
 * turn. The sheet breaks that down where the runtime reports it (Claude Code;
 * Codex reports only the total), explains that Blitz compacts the session
 * before it fills, and offers Compact now. Shown only for providers that
 * report context usage.
 */

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  CONTEXT_CATEGORY_NAMES,
  categoryPercent,
  type TurnContextUsage,
} from "@/lib/context-usage"

/** Fills for the breakdown, strongest first, from the theme's own tokens. */
const CATEGORY_FILLS = [
  "bg-brand",
  "bg-brand/60",
  "bg-brand/35",
  "bg-muted-foreground/40",
] as const

/** Text colours matching `CATEGORY_FILLS`, for the legend dots. */
const CATEGORY_DOTS = [
  "text-brand",
  "text-brand/60",
  "text-brand/35",
  "text-muted-foreground/60",
] as const

/** Props for the context meter. */
type TeachContextMeterProps = {
  /** Usage saved after the last turn. */
  usage: TurnContextUsage
  /** True while Compact now runs. */
  compacting: boolean
  /** Whether Compact now can run: the provider compacts and no reply is being written. */
  canCompact: boolean
  /** Starts Compact now. */
  onCompact: () => void
  /** Why the last Compact now failed, shown in the sheet. */
  error: string
}

/** A small ring filled to `percent`, drawn with the theme's colours. */
function UsageRing({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * 14
  return (
    <svg viewBox="0 0 36 36" className="size-4 -rotate-90" aria-hidden="true">
      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="5" className="stroke-border" />
      <circle
        cx="18"
        cy="18"
        r="14"
        fill="none"
        strokeWidth="5"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(100, percent) / 100)}
        className={percent >= 80 ? "stroke-brand" : "stroke-muted-foreground"}
      />
    </svg>
  )
}

/**
 * Renders the meter chip and its sheet. Without a known window size the chip
 * shows the token count instead of a percentage.
 */
export function TeachContextMeter({
  usage,
  compacting,
  canCompact,
  onCompact,
  error,
}: TeachContextMeterProps) {
  const percent = usage.percent === undefined ? undefined : Math.round(usage.percent)
  const label =
    percent !== undefined
      ? `${percent}%`
      : `${Math.round(usage.usedTokens / 1000)}k tokens`
  const categories = usage.categories ?? []
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            percent !== undefined
              ? `Session context ${percent}% full. Show details`
              : `Session context uses ${label}. Show details`
          }
          className="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 text-xs text-muted-foreground tabular-nums hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {compacting ? (
            <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
          ) : (
            <UsageRing percent={percent ?? 0} />
          )}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(21rem,calc(100vw-2rem))] p-4">
        <h2 className="text-sm font-semibold">Session context</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {percent !== undefined
            ? `${percent}% of the model's context window used`
            : `${usage.usedTokens.toLocaleString()} tokens in the model's context`}
        </p>
        {categories.length && usage.maxTokens ? (
          <>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              {categories.map((category, index) => (
                <span
                  key={category.label}
                  className={CATEGORY_FILLS[index % CATEGORY_FILLS.length]}
                  style={{ width: `${categoryPercent(usage, category) ?? 0}%` }}
                />
              ))}
            </div>
            <dl className="mt-2.5 grid grid-cols-[1fr_auto] gap-y-1 text-xs">
              {categories.map((category, index) => (
                <div key={category.label} className="contents">
                  <dt>
                    <span aria-hidden="true" className={CATEGORY_DOTS[index % CATEGORY_DOTS.length]}>
                      ●
                    </span>{" "}
                    {CONTEXT_CATEGORY_NAMES[category.label]}
                  </dt>
                  <dd className="text-muted-foreground tabular-nums">
                    {categoryPercent(usage, category)}%
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
        <p className="mt-3 border-t border-border pt-2.5 text-xs text-muted-foreground">
          Blitz compacts the session when it gets near full. The outline and your lesson plan are always kept in full.
        </p>
        {error ? (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canCompact || compacting}
          onClick={onCompact}
          className="mt-3 min-h-9 rounded-full px-4"
        >
          {compacting ? (
            <>
              <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" />
              Compacting…
            </>
          ) : (
            "Compact now"
          )}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
