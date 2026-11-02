"use client"

/**
 * The context meter on Teach's Unit options menu, and the details dialog
 * its Session context row opens.
 *
 * The meter shows how full the session's model context is after the last
 * turn. The dialog breaks that down where the runtime reports it (Claude Code;
 * Codex reports only the total), explains that Blitz compacts the session
 * before it fills, and offers Compact now. Shown only for providers that
 * report context usage.
 */

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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

/** Context usage and actions for the controlled details dialog. */
type TeachContextDetailsProps = {
  /** Whether the details dialog is visible. */
  open: boolean
  /** Updates dialog visibility when it is dismissed. */
  onOpenChange: (open: boolean) => void
  /** Restores focus to Unit options when the dialog closes. */
  onCloseAutoFocus: (event: Event) => void
  /** Usage saved after the last turn. */
  usage: TurnContextUsage
  /** True while Compact now runs. */
  compacting: boolean
  /** Whether Compact now can run: the provider compacts and no reply is being written. */
  canCompact: boolean
  /** Starts Compact now. */
  onCompact: () => void
  /** Why the last Compact now failed, shown in the dialog. */
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
 * The context meter shown on the Session context row of Unit options: the
 * ring alone, or a spinner while Compact now runs. When the row is hovered or
 * focused, how full the context is slides out to the left of the ring in a
 * pill. Without a known window size it shows the token count instead of a
 * percentage. The row must carry the `group` class for the pill to open.
 */
export function TeachContextMeter({
  usage,
  compacting,
}: {
  usage: TurnContextUsage
  compacting: boolean
}) {
  const percent = usage.percent === undefined ? undefined : Math.round(usage.percent)
  return (
    <span className="-mr-0.5 ml-auto inline-flex shrink-0 items-center rounded-full p-0.5 text-xs text-muted-foreground tabular-nums transition-colors group-data-[highlighted]:bg-background motion-reduce:transition-none">
      {/* Collapsed to nothing until the row is highlighted; still read by screen readers. */}
      <span className="max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-data-[highlighted]:max-w-24 group-data-[highlighted]:opacity-100 motion-reduce:transition-none">
        <span className="block pr-1.5 pl-2">
          {percent !== undefined ? `${percent}%` : `${Math.round(usage.usedTokens / 1000)}k tokens`}
        </span>
      </span>
      {compacting ? (
        <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
      ) : (
        <UsageRing percent={percent ?? 0} />
      )}
    </span>
  )
}

/** Shows context usage and manual compaction without adding a header control. */
export function TeachContextDetails({
  open,
  onOpenChange,
  onCloseAutoFocus,
  usage,
  compacting,
  canCompact,
  onCompact,
  error,
}: TeachContextDetailsProps) {
  const percent = usage.percent === undefined ? undefined : Math.round(usage.percent)
  const categories = usage.categories ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Session context</DialogTitle>
          <DialogDescription>
            {percent !== undefined
              ? `${percent}% of the model's context window used`
              : `${usage.usedTokens.toLocaleString()} tokens in the model's context`}
          </DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
