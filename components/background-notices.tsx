"use client"

/** Provides short-lived background-job notices that survive client navigation. */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react"

/** Most notices shown at once; the newest keeps the corner stack short over page content. */
const MAX_VISIBLE_NOTICES = 2

/** One user-facing acknowledgement for work that continues after navigation. */
type BackgroundNotice = {
  id: number
  /** Notices with the same key describe one job; a newer one replaces the older. */
  key?: string
  message: string
  href?: string
  label?: string
}

/**
 * Adds one notice to the shared background-job tray.
 * @param key Optional job identity. A notice with a key already showing is replaced rather than stacked.
 */
type NotifyBackgroundNotice = (
  message: string,
  href?: string,
  label?: string,
  key?: string
) => void

const BackgroundNoticeContext = createContext<NotifyBackgroundNotice | null>(
  null
)

/**
 * Renders an eight-second notice tray for background work. The tray holds at
 * most two notices, one per job key, so it covers a small corner of the page.
 */
export function BackgroundNotices({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<BackgroundNotice[]>([])
  const router = useRouter()

  /**
   * Shows one notice with an optional route action, then removes it automatically.
   * A keyed notice drops any earlier notice with the same key, and the oldest
   * notice drops when the tray is full.
   */
  const notify = useCallback<NotifyBackgroundNotice>(
    (message, href, label, key) => {
      const notice = { id: Date.now() + Math.random(), key, message, href, label }
      setNotices((current) =>
        [...current.filter((item) => !key || item.key !== key), notice].slice(
          -MAX_VISIBLE_NOTICES
        )
      )
      window.setTimeout(() => {
        setNotices((current) => current.filter((item) => item.id !== notice.id))
      }, 8_000)
    },
    []
  )

  return (
    <BackgroundNoticeContext.Provider value={notify}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-24 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[min(24rem,calc(100vw-3rem))]"
      >
        {notices.map((notice) => (
          <div
            key={notice.id}
            role="status"
            className="pointer-events-auto flex w-full items-center gap-3 rounded-xl border border-border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
          >
            <span className="min-w-0 flex-1">{notice.message}</span>
            {notice.href && notice.label ? (
              <Link
                href={notice.href}
                onClick={(event) => {
                  event.preventDefault()
                  router.push(notice.href ?? "/notifications")
                }}
                className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium underline-offset-4 hover:underline"
              >
                {notice.label}
              </Link>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() =>
                setNotices((current) =>
                  current.filter((item) => item.id !== notice.id)
                )
              }
              aria-label="Dismiss"
            >
              ×
            </Button>
          </div>
        ))}
      </div>
    </BackgroundNoticeContext.Provider>
  )
}

/** Returns the shared notice function, or a safe no-op before the provider mounts. */
export function useBackgroundNotice(): NotifyBackgroundNotice {
  return useContext(BackgroundNoticeContext) ?? (() => undefined)
}
