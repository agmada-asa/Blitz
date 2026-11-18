/**
 * Lays out one group on the Settings page: the group's name and a short explanation on the left,
 * its controls on the right. Groups stack with a rule between them, and the label moves above
 * the controls on narrow screens. Shared by the page and by settings that render their own group.
 */

import type { ReactNode } from "react"

/** Props for one labelled settings group. */
type SettingsGroupProps = {
  /** Unique id for the heading, used to label the section. */
  id: string
  title: string
  /** One or two sentences that say what the group controls. Optional. */
  description?: ReactNode
  children: ReactNode
}

/** Renders a labelled settings group with the label beside its controls on wide screens. */
export function SettingsGroup({
  id,
  title,
  description,
  children,
}: SettingsGroupProps) {
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 border-t py-7 first:border-t-0 first:pt-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8"
    >
      <div>
        <h2
          id={id}
          className="scroll-mt-8 font-heading text-base font-medium tracking-tight"
        >
          {title}
        </h2>
        {description ? (
          <p className="mt-1 text-sm leading-5 text-pretty text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  )
}
