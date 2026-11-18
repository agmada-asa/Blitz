"use client"

/**
 * Provides the shared shadcn form label. It renders as a block-level flex
 * box, so the spacing utilities on its form group (`space-y-*`, `gap-*`) put
 * a real gap between the label and its field. A bare inline `<label>` gets
 * no gap from Tailwind v4's `space-y-*`, which spaces children with bottom
 * margins that inline elements ignore.
 */

import * as React from "react"
import { Label as LabelPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Renders a visible label for a form field. Pass `htmlFor` with the field's
 * id. Labels of disabled fields dim with their field.
 */
export function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-snug font-medium text-foreground select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}
