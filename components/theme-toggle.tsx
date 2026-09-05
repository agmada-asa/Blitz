"use client"

/** Owns the three-way theme selector used by the settings appearance section. */

import { useTheme } from "next-themes"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { ComputerIconComponent, MoonIcon, SunIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Theme values accepted by next-themes and shown in the appearance selector. */
type ThemeValue = "system" | "light" | "dark"

/** One theme option and its supporting icon. */
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeValue
  label: string
  icon: typeof ComputerIconComponent
}> = [
  { value: "system", label: "System", icon: ComputerIconComponent },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
]

/** Visual options for the shared theme selector. */
type ThemeToggleProps = {
  className?: string
}

/** Reports whether a next-themes value can be selected by the appearance UI. */
function isThemeValue(value: string | undefined): value is ThemeValue {
  return value === "system" || value === "light" || value === "dark"
}

/** Renders the light, dark, and system theme choices after hydration. */
export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const mounted = React.useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false
  )
  const selectedTheme = mounted && isThemeValue(theme) ? theme : null

  return (
    <div
      role="group"
      aria-label="Theme"
      className={cn("grid grid-cols-3 gap-2", className)}
    >
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = selectedTheme === value
        return (
          <Button
            key={value}
            type="button"
            variant="outline"
            aria-pressed={selected}
            disabled={!mounted}
            onClick={() => setTheme(value)}
            className={cn(
              "h-11 min-w-0 rounded-xl px-2 sm:px-3",
              selected &&
                "border-brand bg-brand/10 text-brand hover:bg-brand/15 hover:text-brand"
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            <span>{label}</span>
          </Button>
        )
      })}
    </div>
  )
}
