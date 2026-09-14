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

/** One user-facing acknowledgement for work that continues after navigation. */
type BackgroundNotice = {
  id: number
  message: string
  href?: string
  label?: string
}

/** Adds one notice to the shared background-job tray. */
type NotifyBackgroundNotice = (
  message: string,
  href?: string,
  label?: string
) => void

const BackgroundNoticeContext = createContext<NotifyBackgroundNotice | null>(
  null
)

/** Renders an eight-second notice tray for background work. */
export function BackgroundNotices({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<BackgroundNotice[]>([])
  const router = useRouter()

  /** Shows one notice with an optional route action, then removes it automatically. */
  const notify = useCallback<NotifyBackgroundNotice>((message, href, label) => {
    const notice = { id: Date.now() + Math.random(), message, href, label }
    setNotices((current) => [...current.slice(-2), notice])
    window.setTimeout(() => {
      setNotices((current) => current.filter((item) => item.id !== notice.id))
    }, 8_000)
  }, [])

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
