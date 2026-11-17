"use client"

/**
 * Lets the learner choose whether links to Blitz that open in this Mac
 * browser reopen in the desktop app (`components/desktop-handoff.tsx`).
 *
 * The section appears only in a Mac browser on the Mac whose Blitz app opens
 * links. The choice is saved per browser and address, like the accent colour.
 */

import { useEffect, useState } from "react"

import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  desktopAppAnswersLinks,
  isMacBrowser,
  readLinkPreference,
  saveLinkPreference,
} from "@/lib/client/desktop-links"

/** Renders the Desktop app settings section, or nothing where it can't apply. */
export function DesktopLinkSettings() {
  const [available, setAvailable] = useState(false)
  const [openInApp, setOpenInApp] = useState(true)

  useEffect(() => {
    if (
      window.blitzDesktop ||
      !isMacBrowser(navigator.userAgent, navigator.maxTouchPoints)
    )
      return
    let active = true
    void desktopAppAnswersLinks().then((opensLinks) => {
      if (!active) return
      setOpenInApp(readLinkPreference() !== "browser")
      setAvailable(opensLinks)
    })
    return () => {
      active = false
    }
  }, [])

  if (!available) return null

  return (
    <section aria-labelledby="desktop-app-heading" className="space-y-4">
      <div>
        <h2
          id="desktop-app-heading"
          className="scroll-mt-8 font-heading text-xl font-medium tracking-tight"
        >
          Desktop app
        </h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          Choose where links to Blitz open on this Mac.
        </p>
      </div>
      <Card className="gap-0 py-0">
        <CardContent className="px-0">
          <label
            htmlFor="open-links-in-app"
            className="flex cursor-pointer items-start gap-3 px-4 py-5"
          >
            <Checkbox
              id="open-links-in-app"
              checked={openInApp}
              onCheckedChange={(checked) => {
                const next = checked === true
                setOpenInApp(next)
                saveLinkPreference(next ? "app" : "browser")
              }}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm font-medium">
                Open links in the app
              </span>
              <span className="mt-1 block text-sm leading-5 text-muted-foreground">
                A link to Blitz that opens in this browser moves to the Blitz
                app. Turn this off to stay in the browser.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>
    </section>
  )
}
