"use client"

/** Watches durable work, tracks unread results, and emits in-app or browser alerts. */

import { useQuery } from "convex/react"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { FunctionReturnType } from "convex/server"

import { useBackgroundNotice } from "@/components/background-notices"
import { api } from "@/convex/_generated/api"

/** Browser storage key for the latest time the notification center was opened. */
const LAST_READ_KEY = "blitz-notifications-last-read-v1"
/** Browser storage key for finished rows already announced on this device. */
const DELIVERED_KEY = "blitz-notifications-delivered-v1"
/** Maximum delivered identifiers kept on one device. */
const MAX_DELIVERED_IDS = 120

/** Live notification-center response inferred from the public Convex query. */
export type NotificationSnapshot = FunctionReturnType<typeof api.activity.list>
/** One active or terminal row returned by the notification-center query. */
export type NotificationRow = NotificationSnapshot["tasks"][number]
/** Browser notification availability and permission state. */
export type BrowserNotificationPermission =
  NotificationPermission | "unsupported"

/** Values shared by the navigation and notification page. */
type NotificationContextValue = {
  snapshot: NotificationSnapshot | undefined
  unreadCount: number
  browserPermission: BrowserNotificationPermission
  markAllRead: () => void
  requestBrowserNotifications: () => Promise<BrowserNotificationPermission>
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

/** Reads a finite timestamp or initializes the first-read baseline. */
function readTimestamp(key: string): number {
  const stored = window.localStorage.getItem(key)
  const parsed = Number.parseInt(stored ?? "", 10)
  if (stored !== null && Number.isFinite(parsed) && parsed >= 0) return parsed
  const baseline = Date.now()
  window.localStorage.setItem(key, String(baseline))
  return baseline
}

/** Reads the delivered identifiers and whether this device has a prior baseline. */
function readDeliveredIds(): { ids: Set<string>; initialized: boolean } {
  const stored = window.localStorage.getItem(DELIVERED_KEY)
  try {
    const value = JSON.parse(stored ?? "[]")
    return {
      ids: new Set(
        Array.isArray(value)
          ? value
              .filter((id): id is string => typeof id === "string")
              .slice(-MAX_DELIVERED_IDS)
          : []
      ),
      initialized: stored !== null,
    }
  } catch {
    return { ids: new Set(), initialized: false }
  }
}

/** Opens a browser notification destination in the current Blitz window. */
function openNotificationDestination(href: string): void {
  window.focus()
  window.location.assign(href)
}

/** Sends one clickable system notification when the browser permits it. */
function announceInBrowser(item: NotificationRow): void {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return
  try {
    const notification = new Notification(item.title, {
      body: item.context ? `${item.detail} · ${item.context}` : item.detail,
      tag: item.id,
    })
    notification.onclick = () => openNotificationDestination(item.href)
  } catch {
    // The in-app notification remains available when a browser blocks its API.
  }
}

/** Provides live task state and announces newly finished work once per browser. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const snapshot = useQuery(api.activity.list)
  const notifyBackground = useBackgroundNotice()
  const deliveredIds = useRef<Set<string> | null>(null)
  const [lastReadAt, setLastReadAt] = useState<number | null>(null)
  const [browserPermission, setBrowserPermission] =
    useState<BrowserNotificationPermission>("unsupported")

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setLastReadAt(readTimestamp(LAST_READ_KEY))
      setBrowserPermission(
        "Notification" in window ? Notification.permission : "unsupported"
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (!snapshot) return
    const stored = readDeliveredIds()
    if (deliveredIds.current === null) {
      deliveredIds.current = stored.ids
      if (!stored.initialized) {
        deliveredIds.current = new Set(
          snapshot.notifications.map((item) => item.id)
        )
        window.localStorage.setItem(
          DELIVERED_KEY,
          JSON.stringify([...deliveredIds.current].slice(-MAX_DELIVERED_IDS))
        )
        return
      }
    }

    const allUnseen = snapshot.notifications
      .filter((item) => !deliveredIds.current!.has(item.id))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    const announced = allUnseen.slice(-5)
    for (const item of announced) {
      notifyBackground(item.title, item.href, "Open")
      announceInBrowser(item)
    }
    for (const item of snapshot.notifications) deliveredIds.current.add(item.id)
    if (allUnseen.length)
      window.localStorage.setItem(
        DELIVERED_KEY,
        JSON.stringify([...deliveredIds.current].slice(-MAX_DELIVERED_IDS))
      )
  }, [notifyBackground, snapshot])

  /** Marks every result currently visible to the browser as read. */
  const markAllRead = useCallback(() => {
    const readAt = Date.now()
    window.localStorage.setItem(LAST_READ_KEY, String(readAt))
    setLastReadAt(readAt)
  }, [])

  /** Requests browser alert permission from an explicit user action. */
  const requestBrowserNotifications = useCallback(async () => {
    if (!("Notification" in window)) {
      setBrowserPermission("unsupported")
      return "unsupported" as const
    }
    const permission = await Notification.requestPermission()
    setBrowserPermission(permission)
    if (permission === "granted" && snapshot) {
      deliveredIds.current = new Set(
        snapshot.notifications.map((item) => item.id)
      )
      window.localStorage.setItem(
        DELIVERED_KEY,
        JSON.stringify([...deliveredIds.current].slice(-MAX_DELIVERED_IDS))
      )
    }
    return permission
  }, [snapshot])

  const unreadCount = useMemo(
    () =>
      lastReadAt === null || !snapshot
        ? 0
        : snapshot.notifications.filter((item) => item.updatedAt > lastReadAt)
            .length,
    [lastReadAt, snapshot]
  )
  const value = useMemo<NotificationContextValue>(
    () => ({
      snapshot,
      unreadCount,
      browserPermission,
      markAllRead,
      requestBrowserNotifications,
    }),
    [
      browserPermission,
      markAllRead,
      requestBrowserNotifications,
      snapshot,
      unreadCount,
    ]
  )

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}

/** Returns notification state for the shell or notification page. */
export function useNotifications(): NotificationContextValue {
  const value = useContext(NotificationContext)
  if (!value)
    throw new Error("useNotifications must be used within NotificationProvider")
  return value
}
