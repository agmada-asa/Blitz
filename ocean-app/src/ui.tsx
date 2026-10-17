/**
 * @file ocean-app/src/ui.tsx
 * @description Small layout pieces shared by the mini app's screens: the screen header, list
 * rows, sections, a bottom sheet and the loading, empty and error states. Controls themselves
 * are Blitz's own shadcn components from `components/ui/`.
 */

import * as React from "react"
import { Button } from "@/components/ui/button"
import { ArrowLeftIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"
import { back as goBack } from "./data"

/**
 * A screen's heading, with a back button on screens opened from a list.
 *
 * @param props.title Heading text.
 * @param props.detail Optional line under the heading.
 * @param props.back Whether to show the back button.
 * @param props.action Optional control on the right.
 */
export function ScreenHeader({
  title,
  detail,
  back,
  action,
}: {
  title: string
  detail?: React.ReactNode
  back?: boolean
  action?: React.ReactNode
}) {
  return (
    <header className="flex items-start gap-2 px-5 pt-5 pb-3">
      {back ? (
        <Button
          variant="ghost"
          size="icon"
          className="mt-0.5 -ml-2 shrink-0"
          aria-label="Back"
          onClick={goBack}
        >
          <ArrowLeftIcon className="size-5" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[22px] font-semibold tracking-[-0.02em]">
          {title}
        </h1>
        {detail ? (
          <p className="mt-1 text-[13px] text-muted-foreground">{detail}</p>
        ) : null}
      </div>
      {action}
    </header>
  )
}

/**
 * One tappable row in a list.
 *
 * @param props.title Main line.
 * @param props.meta Short text on the right of the main line, such as a percentage.
 * @param props.detail Up to two lines under it.
 * @param props.progress Optional share done, 0 to 1, drawn as a thin bar.
 * @param props.onOpen Called when tapped.
 */
export function Row({
  title,
  meta,
  detail,
  progress,
  onOpen,
}: {
  title: string
  meta?: string
  detail?: string
  progress?: number
  onOpen?: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="block w-full px-5 py-3 text-left transition-colors active:bg-muted"
      >
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
            {title}
          </span>
          {meta ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {meta}
            </span>
          ) : null}
        </span>
        {detail ? (
          <span className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
            {detail}
          </span>
        ) : null}
        {progress !== undefined ? <Bar value={progress} /> : null}
      </button>
    </li>
  )
}

/**
 * A thin progress bar in the brand colour.
 *
 * @param props.value Share done, 0 to 1.
 * @param props.className Extra classes, such as margins.
 */
export function Bar({
  value,
  className,
}: {
  value: number
  className?: string
}) {
  return (
    <span
      className={cn(
        "mt-2 block h-1 overflow-hidden rounded-full bg-muted",
        className
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
    >
      <span
        className="block h-full rounded-full bg-brand transition-[width]"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  )
}

/**
 * A list of rows separated by hairlines.
 *
 * @param props.children `Row` elements.
 */
export function List({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y divide-border">{children}</ul>
}

/**
 * A titled block on a screen.
 *
 * @param props.title Section heading.
 * @param props.children Its content.
 */
export function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="py-3">
      <h2 className="mb-1 px-5 text-xs font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * A sheet that rises from the bottom of the screen; tapping outside closes it.
 *
 * @param props.title Heading.
 * @param props.detail Optional line under it.
 * @param props.onClose Closes the sheet.
 * @param props.children Its content.
 */
export function Sheet({
  title,
  detail,
  onClose,
  children,
}: {
  title: string
  detail?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className="w-full rounded-t-3xl bg-background p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[17px] font-semibold">{title}</h2>
        {detail ? (
          <p className="mt-1 text-[13px] text-muted-foreground">{detail}</p>
        ) : null}
        {children}
      </div>
    </div>
  )
}

/**
 * What a screen shows while it has nothing to list: loading, an error with a retry, or empty.
 *
 * @param props.loading Whether the first read is running.
 * @param props.error The read's error, if it failed.
 * @param props.empty Text for an empty result.
 * @param props.onRetry Reads again.
 */
export function Status({
  loading,
  error,
  empty,
  onRetry,
}: {
  loading?: boolean
  error?: string | null
  empty?: string
  onRetry?: () => void
}) {
  if (error) {
    return (
      <div className="px-5 py-8 text-[14px]">
        <p className="text-destructive">{error}</p>
        {onRetry ? (
          <Button
            variant="outline"
            size="lg"
            className="mt-3"
            onClick={onRetry}
          >
            Try again
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <p className="px-5 py-8 text-[14px] text-muted-foreground">
      {loading ? "Loading…" : empty}
    </p>
  )
}
