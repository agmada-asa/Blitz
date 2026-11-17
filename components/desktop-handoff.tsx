"use client"

/**
 * Reopens a Blitz page in the desktop app when a link to it lands in a Mac
 * browser, then says so in a small notice with a way to try again.
 *
 * The rules for when it hands over live in `lib/client/desktop-links.ts`; the
 * learner can keep links in the browser from Settings.
 */

import Link from "next/link"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { CancelIcon } from "@/components/ui/icon"
import {
  desktopAppAnswersLinks,
  desktopLink,
  isMacBrowser,
  openInDesktopApp,
  readLinkPreference,
  shouldHandOff,
} from "@/lib/client/desktop-links"

/** Hands the first page load over to the desktop app and renders the notice afterwards. */
export function DesktopHandoff() {
  const [link, setLink] = useState<string>()

  useEffect(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined
    if (
      !shouldHandOff({
        inDesktopApp: Boolean(window.blitzDesktop),
        macBrowser: isMacBrowser(navigator.userAgent, navigator.maxTouchPoints),
        preference: readLinkPreference(),
        navigationType: navigation?.type,
        referrer: document.referrer,
        origin: window.location.origin,
      })
    )
      return
    let active = true
    void desktopAppAnswersLinks().then((opensLinks) => {
      if (!active || !opensLinks) return
      const target = desktopLink(window.location)
      openInDesktopApp(target)
      setLink(target)
    })
    return () => {
      active = false
    }
  }, [])

  if (!link) return null

  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[calc(84px+env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-border bg-background py-2 pr-2 pl-4 text-sm shadow-sm md:bottom-6"
    >
      <p className="min-w-0 flex-1 leading-5 text-muted-foreground">
        Opening this page in the Blitz app.{" "}
        <Link
          href="/settings"
          className="text-foreground underline-offset-4 hover:underline"
        >
          Change in Settings
        </Link>
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => openInDesktopApp(link)}
      >
        Open again
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        onClick={() => setLink(undefined)}
      >
        <CancelIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
