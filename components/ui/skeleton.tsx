/** Defines a reduced-detail placeholder for content that is still loading. */

import { cn } from "@/lib/utils"

/** Renders a pulsing placeholder block with caller-controlled dimensions. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
