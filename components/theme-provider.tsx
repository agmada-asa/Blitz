"use client"

/** Owns system-aware theme state and the global keyboard theme shortcut. */

import * as React from "react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

import { AccentProvider } from "@/components/accent-provider"

/** Provides theme state and installs the non-input "d" keyboard shortcut. */
function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <AccentProvider>
        <ThemeHotkey />
        {children}
      </AccentProvider>
    </NextThemesProvider>
  )
}

/** Reports whether a keyboard event started in an editable control. */
function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

/** Toggles light and dark themes on an unmodified "d" key press outside inputs. */
function ThemeHotkey() {
  const { resolvedTheme, setTheme } = useTheme()

  React.useEffect(() => {
    /** Handles one global keydown without interfering with typing or shortcuts. */
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      setTheme(resolvedTheme === "dark" ? "light" : "dark")
    }

    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [resolvedTheme, setTheme])

  return null
}

export { ThemeProvider }
