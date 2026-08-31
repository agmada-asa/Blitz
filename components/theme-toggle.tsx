"use client"

/** Renders the explicit light and dark theme control used by the app shell. */

import { useTheme } from "next-themes"
import * as React from "react"

import { ComputerIconComponent, MoonIcon, SunIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Toggles the resolved theme after hydration and labels the next action. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme()
  const mounted = React.useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  )
  const isDark = mounted && resolvedTheme === "dark"

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-full border border-border bg-background/80 text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        className
      )}
    >
      {mounted ? (
        isDark ? (
          <SunIcon aria-hidden="true" size={19} />
        ) : (
          <MoonIcon aria-hidden="true" size={19} />
        )
      ) : (
        <ComputerIconComponent aria-hidden="true" size={19} />
      )}
    </button>
  )
}
