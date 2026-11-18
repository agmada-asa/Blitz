"use client"

/**
 * Wraps the Radix collapsible primitives as the shared shadcn disclosure: a
 * trigger that shows or hides one region, with `aria-expanded` and
 * `aria-controls` wired up. Use it for any list or panel that folds away, so
 * every fold in Blitz behaves and reads the same way. Style the trigger with
 * `data-[state=open]` (for example to turn a chevron).
 */

import * as React from "react"
import { Collapsible as CollapsiblePrimitive } from "radix-ui"

/** Holds the open state of one folding region; controlled or uncontrolled. */
function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

/** Toggles its collapsible; renders a button unless `asChild` is passed. */
function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

/** The region that shows while its collapsible is open and unmounts when closed. */
function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
