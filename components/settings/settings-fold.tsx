"use client"

/**
 * Folds a long block of settings behind one row that names it and summarises it, so the Settings
 * page stays short. The settings stay mounted while folded, so loading and unsaved edits survive
 * closing and opening the row.
 */

import { useId, useState, type ReactNode } from "react"

import { ArrowRightIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Props for one folded block of settings. */
type SettingsFoldProps = {
  title: string
  /** A few words on what is inside, shown under the title while folded and open. */
  summary: string
  children: ReactNode
}

/** Renders a row that opens to show its settings below it. Starts folded. */
export function SettingsFold({ title, summary, children }: SettingsFoldProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-14 w-full items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-sm text-muted-foreground">{summary}</span>
        </span>
        <ArrowRightIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-90"
          )}
        />
      </button>
      <div id={panelId} hidden={!open} className="mt-3 space-y-3">
        {children}
      </div>
    </div>
  )
}
