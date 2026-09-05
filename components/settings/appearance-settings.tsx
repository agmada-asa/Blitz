"use client"

/** Renders the appearance controls for theme and accent colour preferences. */

import { ACCENT_OPTIONS, useAccent } from "@/components/accent-provider"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { CheckIcon } from "@/components/ui/icon"
import { cn } from "@/lib/utils"

/** Renders theme and accent controls in the shared settings card. */
export function AppearanceSettings() {
  const { accent, setAccent } = useAccent()

  return (
    <Card className="gap-0 py-0">
      <CardContent className="divide-y px-0">
        <div className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] sm:items-center sm:gap-6">
          <div>
            <h3 className="text-sm font-medium">Theme</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Use your device setting or choose light or dark mode.
            </p>
          </div>
          <ThemeToggle className="w-full" />
        </div>
        <div className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] sm:items-center sm:gap-6">
          <div>
            <h3 className="text-sm font-medium">Accent colour</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Pick the colour used for active controls and key actions.
            </p>
          </div>
          <div
            role="group"
            aria-label="Accent colour"
            className="flex w-full flex-nowrap justify-between gap-1 sm:justify-end sm:gap-2"
          >
            {ACCENT_OPTIONS.map((option) => {
              const selected = accent === option.id
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`${option.label} accent colour`}
                  aria-pressed={selected}
                  title={option.label}
                  onClick={() => setAccent(option.id)}
                  className={cn(
                    "size-8 rounded-full border-2 p-0 shadow-none sm:size-9",
                    selected &&
                      "ring-2 ring-brand ring-offset-2 ring-offset-background"
                  )}
                  style={{
                    backgroundColor: option.swatch,
                    color: option.swatchForeground,
                  }}
                >
                  {selected ? (
                    <CheckIcon aria-hidden="true" className="size-5" />
                  ) : null}
                </Button>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
