"use client"

/** Wraps Radix Select primitives in the shared shadcn picker presentation. */

import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"

import { ArrowDownIcon, CheckIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Provides controlled or uncontrolled value state for one accessible picker. */
function Select({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

/** Groups related options inside a picker menu. */
function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

/** Displays the selected item's text inside a select trigger. */
function SelectValue({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

/** Visual style options for select triggers. */
type SelectTriggerVariant = "default" | "ghost"

/** Props accepted by the accessible picker trigger. */
type SelectTriggerProps = React.ComponentProps<
  typeof SelectPrimitive.Trigger
> & {
  variant?: SelectTriggerVariant
  showArrow?: boolean
}

/** Opens a picker and renders its current selection with the shared field styling. */
function SelectTrigger({
  className,
  children,
  variant = "default",
  showArrow = true,
  ...props
}: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "flex h-8 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg text-left text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[placeholder]:text-muted-foreground [&>[data-slot=select-value]]:line-clamp-1",
        variant === "default" &&
          "border border-input bg-transparent px-2.5 py-1 disabled:bg-input/50 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        variant === "ghost" &&
          "border-transparent bg-transparent px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
        className
      )}
      {...props}
    >
      {children}
      {showArrow ? (
        <SelectPrimitive.Icon className="inline-flex shrink-0 items-center justify-center">
          <ArrowDownIcon
            aria-hidden="true"
            className="size-3.5 opacity-60"
          />
        </SelectPrimitive.Icon>
      ) : null}
    </SelectPrimitive.Trigger>
  )
}

/** Positions the selectable menu in a portal above surrounding page content. */
function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "z-50 max-h-72 min-w-36 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
          position === "popper" &&
            "w-[var(--radix-select-trigger-width)] min-w-[var(--radix-select-trigger-width)]",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn(
            "max-h-64 overflow-y-auto p-1",
            position === "popper" &&
              "w-full min-w-[var(--radix-select-trigger-width)]"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

/** Renders one keyboard-selectable option with a visible selected-state indicator. */
function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-9 w-full cursor-default items-center gap-2 rounded-lg py-1.5 pr-8 pl-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted data-[highlighted]:text-foreground",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon aria-hidden="true" className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  )
}

/** Labels a group of picker options without making the label selectable. */
function SelectLabel({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/** Separates related option groups inside a picker menu. */
function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  type SelectTriggerProps,
  type SelectTriggerVariant,
}
