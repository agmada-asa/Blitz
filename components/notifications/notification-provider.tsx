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
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { isNotificationInCurrentChat } from "@/lib/notifications"
import { usePathname } from "next/navigation"

/** Browser storage key for individual read notification IDs. */
const READ_IDS_KEY = "blitz-notifications-read-ids-v1"
/** Legacy browser storage key for the latest time the notification center was opened. */
const LAST_READ_KEY = "blitz-notifications-last-read-v1"
/** Browser storage key for finished rows already announced on this device. */
const DELIVERED_KEY = "blitz-notifications-delivered-v1"
/** Maximum delivered identifiers kept on one device. */
const MAX_DELIVERED_IDS = 120
/** Maximum read notification identifiers kept in local storage. */
const MAX_READ_IDS = 200

/** Live notification-center response inferred from the public Convex query. */
export type NotificationSnapshot = FunctionReturnType<typeof api.activity.list>
/** One active or terminal row returned by the notification-center query. */
export type NotificationRow = NotificationSnapshot["tasks"][number]

/**
 * Returns the toast key for a notification, so a newer state of the same job
 * replaces its older toast. Mock exam rows (ready, then marked) share their
 * paper's key; any other row keys on its own ID.
 * @param item A notification row whose `href` may name an exam paper.
 */
function noticeKey(item: { id: string; href: string }): string {
  const paper = /\/practice\/exam\/([^/?#]+)/.exec(item.href)
  return paper ? `exam-paper:${paper[1]}` : item.id
}
/** Browser notification availability and permission state. */
export type BrowserNotificationPermission =
  NotificationPermission | "unsupported"

/** Values shared by the navigation and notification page. */
export type NotificationContextValue = {
  snapshot: NotificationSnapshot | undefined
  unreadCount: number
  browserPermission: BrowserNotificationPermission
  isRead: (id: string) => boolean
  markAsRead: (id: string) => void
  markAsUnread: (id: string) => void
  markAllRead: () => void
  requestBrowserNotifications: () => Promise<BrowserNotificationPermission>
}

const NotificationContext = createContext<NotificationContextValue | null>(null)

/** Reads the persisted read notification identifiers from local storage. */
function readStoredReadIds(): { ids: Set<string>; initialized: boolean } {
  const stored = window.localStorage.getItem(READ_IDS_KEY)
  if (stored !== null) {
    try {
      const parsed = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        return {
          ids: new Set(
            parsed.filter((id): id is string => typeof id === "string")
          ),
          initialized: true,
        }
      }
    } catch {
      // Fall through to uninitialized if corrupted.
    }
  }
  return { ids: new Set(), initialized: false }
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
  window.location.assign(new URL(href, window.location.origin).toString())
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

/** Provides live task state, unread tracking, and in-app or browser alerts. */
export function NotificationProvider({ children }: { children: ReactNode }) {
  const now = useMinuteClock()
  const snapshot = useQuery(api.activity.list, { now })
  const notifyBackground = useBackgroundNotice()
  const pathname = usePathname()
  const deliveredIds = useRef<Set<string> | null>(null)
  const legacyMigrated = useRef(false)
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set())
  const [readIdsInitialized, setReadIdsInitialized] = useState(false)
  const [browserPermission, setBrowserPermission] =
    useState<BrowserNotificationPermission>("unsupported")

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readStoredReadIds()
      if (stored.initialized) {
        setReadIds(stored.ids)
        setReadIdsInitialized(true)
      }
      setBrowserPermission(
        "Notification" in window ? Notification.permission : "unsupported"
      )
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  // Synchronize read identifiers across concurrent browser tabs.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === READ_IDS_KEY) {
        const stored = readStoredReadIds()
        if (stored.initialized) {
          setReadIds(stored.ids)
        }
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  // Migrate legacy lastReadAt timestamp or initialize baseline when snapshot loads.
  useEffect(() => {
    if (!snapshot || legacyMigrated.current || readIdsInitialized) return
    legacyMigrated.current = true

    const hasStoredReadIds = window.localStorage.getItem(READ_IDS_KEY) !== null
    if (!hasStoredReadIds) {
      const legacyStored = window.localStorage.getItem(LAST_READ_KEY)
      const legacyLastReadAt = legacyStored
        ? Number.parseInt(legacyStored, 10)
        : null

      if (legacyLastReadAt !== null && Number.isFinite(legacyLastReadAt)) {
        const migrated = new Set<string>()
        for (const item of snapshot.notifications) {
          if (item.updatedAt <= legacyLastReadAt) {
            migrated.add(item.id)
          }
        }
        const serialized = [...migrated].slice(-MAX_READ_IDS)
        try {
          window.localStorage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
        } catch {
          // Continue if storage is unavailable.
        }
        window.setTimeout(() => setReadIds(new Set(serialized)), 0)
      } else {
        try {
          window.localStorage.setItem(READ_IDS_KEY, JSON.stringify([]))
        } catch {
          // Continue if storage is unavailable.
        }
      }
    }
    setReadIdsInitialized(true)
  }, [readIdsInitialized, snapshot])

  useEffect(() => {
    if (!snapshot) return
    const stored = readDeliveredIds()
    if (deliveredIds.current === null) {
      deliveredIds.current = stored.ids
      if (!stored.initialized) {
        deliveredIds.current = new Set(
          [...snapshot.notifications, ...snapshot.chatNotifications].map(
            (item) => item.id
          )
        )
        window.localStorage.setItem(
          DELIVERED_KEY,
          JSON.stringify([...deliveredIds.current].slice(-MAX_DELIVERED_IDS))
        )
        return
      }
    }

    const allUnseen = [...snapshot.notifications, ...snapshot.chatNotifications]
      .filter((item) => !deliveredIds.current!.has(item.id))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    const announced = allUnseen.slice(-5)
    for (const item of announced) {
      if (
        (item.kind === "card-reply" || item.kind === "workspace-reply") &&
        isNotificationInCurrentChat(
          item.kind,
          item.href,
          pathname,
          window.location.search
        )
      ) {
        continue
      }
      notifyBackground(item.title, item.href, "Open", noticeKey(item))
      announceInBrowser(item)
    }
    for (const item of [...snapshot.notifications, ...snapshot.chatNotifications])
      deliveredIds.current.add(item.id)
    if (allUnseen.length)
      window.localStorage.setItem(
        DELIVERED_KEY,
        JSON.stringify([...deliveredIds.current].slice(-MAX_DELIVERED_IDS))
      )
  }, [notifyBackground, pathname, snapshot])

  /** Marks one notification as read and persists the updated identifiers. */
  const markAsRead = useCallback((id: string) => {
    setReadIds((current) => {
      if (current.has(id)) return current
      const updated = new Set(current)
      updated.add(id)
      const serialized = [...updated].slice(-MAX_READ_IDS)
      try {
        window.localStorage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
      } catch {
        // Continue if storage quota is exceeded.
      }
      return new Set(serialized)
    })
  }, [])

  /** Marks one notification as unread and persists the updated identifiers. */
  const markAsUnread = useCallback((id: string) => {
    setReadIds((current) => {
      if (!current.has(id)) return current
      const updated = new Set(current)
      updated.delete(id)
      const serialized = [...updated]
      try {
        window.localStorage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
      } catch {
        // Continue if storage quota is exceeded.
      }
      return updated
    })
  }, [])

  /** Marks every finished notification currently in the snapshot as read. */
  const markAllRead = useCallback(() => {
    if (!snapshot) return
    setReadIds((current) => {
      const updated = new Set(current)
      for (const item of snapshot.notifications) {
        updated.add(item.id)
      }
      const serialized = [...updated].slice(-MAX_READ_IDS)
      try {
        window.localStorage.setItem(READ_IDS_KEY, JSON.stringify(serialized))
      } catch {
        // Continue if storage quota is exceeded.
      }
      return new Set(serialized)
    })
  }, [snapshot])

  /** Checks whether one notification ID has been marked read on this device. */
  const isRead = useCallback((id: string) => readIds.has(id), [readIds])

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
        [...snapshot.notifications, ...snapshot.chatNotifications].map(
          (item) => item.id
        )
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
      !snapshot
        ? 0
        : snapshot.notifications.filter((item) => !readIds.has(item.id)).length,
    [readIds, snapshot]
  )
  const value = useMemo<NotificationContextValue>(
    () => ({
      snapshot,
      unreadCount,
      browserPermission,
      isRead,
      markAsRead,
      markAsUnread,
      markAllRead,
      requestBrowserNotifications,
    }),
    [
      browserPermission,
      isRead,
      markAllRead,
      markAsRead,
      markAsUnread,
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
