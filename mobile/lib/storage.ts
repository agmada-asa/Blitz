/**
 * Persists a bounded prepared-feed cache and retry queue in AsyncStorage.
 * Writes are serialized at the call site and malformed local data is treated
 * as absent so a corrupt cache cannot prevent the app from booting.
 */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { randomUUID } from "expo-crypto"

import type {
  MobileAnswer,
  MobileFeedPayload,
  MobilePendingEvent,
} from "./contracts"
import {
  appendPendingEvent,
  MAX_PENDING_EVENTS,
  removePendingEventFromQueue,
} from "./pending-events"
import { legacyMigrationAction } from "./storage-policy"

const FEED_KEY = "@blitz/mobile/feed-v1"
const EVENTS_KEY = "@blitz/mobile/events-v1"
const SERVER_URL_KEY = "@blitz/mobile/server-url-v1"
const LEGACY_OWNER_KEY = "@blitz/mobile/legacy-owner-v1"
const MAX_CACHED_ITEMS = 60
let eventMutation = Promise.resolve()

/** Derives a stable storage key so caches and queues never cross server boundaries. */
function scopedKey(prefix: string, serverUrl?: string): string {
  if (!serverUrl?.trim()) return prefix
  const normalized = serverUrl.trim().replace(/\/+$/, "")
  return `${prefix}:${encodeURIComponent(normalized)}`
}

/** The persisted cache envelope, versioned for safe future migrations. */
export type MobileFeedCache = {
  readonly version: 1
  readonly savedAt: number
  readonly payload: MobileFeedPayload
  readonly serverUrl?: string
}

/** Reads JSON from AsyncStorage and returns undefined for malformed values. */
async function readJson<T>(key: string): Promise<T | undefined> {
  const raw = await AsyncStorage.getItem(key)
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** Loads the latest bounded feed cache, if one exists. */
export async function loadFeedCache(
  serverUrl?: string
): Promise<MobileFeedCache | undefined> {
  const value = await readJson<MobileFeedCache>(scopedKey(FEED_KEY, serverUrl))
  if (
    value?.version !== 1 ||
    !value.payload ||
    !Array.isArray(value.payload.cards)
  ) {
    return undefined
  }
  return value
}

/** Stores only the first bounded slice of a prepared feed for offline use. */
export async function saveFeedCache(
  payload: MobileFeedPayload,
  serverUrl?: string
): Promise<void> {
  const cache: MobileFeedCache = {
    version: 1,
    savedAt: Date.now(),
    payload: { ...payload, cards: payload.cards.slice(0, MAX_CACHED_ITEMS) },
    ...(serverUrl?.trim()
      ? { serverUrl: serverUrl.trim().replace(/\/+$/, "") }
      : {}),
  }
  await AsyncStorage.setItem(
    scopedKey(FEED_KEY, serverUrl),
    JSON.stringify(cache)
  )
}

/** Loads the user's last server URL, if configured. */
export async function loadServerUrl(): Promise<string | undefined> {
  const value = await AsyncStorage.getItem(SERVER_URL_KEY)
  return value?.trim() || undefined
}

/** Stores a validated server URL for the next app launch. */
export async function saveServerUrl(baseUrl: string): Promise<void> {
  await AsyncStorage.setItem(SERVER_URL_KEY, baseUrl.trim())
}

/** Loads queued answer and passive events, dropping malformed entries. */
export async function loadPendingEvents(
  serverUrl?: string
): Promise<MobilePendingEvent[]> {
  const value = await readJson<MobilePendingEvent[]>(
    scopedKey(EVENTS_KEY, serverUrl)
  )
  if (!Array.isArray(value)) return []
  return value.filter((event) => {
    if (
      typeof event?.eventId !== "string" ||
      typeof event.projectId !== "string" ||
      typeof event.cardId !== "string" ||
      !Number.isFinite(event.occurredAt)
    ) {
      return false
    }
    if (event.type === "answer") return event.answer !== undefined
    return event.type === "skip" || event.type === "exposure"
  })
}

/** Normalizes a server identity for durable legacy ownership decisions. */
function normalizedServer(serverUrl: string): string {
  return serverUrl.trim().replace(/\/+$/, "")
}

/** Claims legacy cache and queue data for the known prior server exactly once. */
export async function migrateLegacyData(serverUrl?: string): Promise<void> {
  if (!serverUrl?.trim()) return
  const owner = normalizedServer(serverUrl)
  const existingOwner = await AsyncStorage.getItem(LEGACY_OWNER_KEY)
  const [legacyCache, legacyEvents] = await Promise.all([
    AsyncStorage.getItem(FEED_KEY),
    AsyncStorage.getItem(EVENTS_KEY),
  ])
  if (
    legacyMigrationAction(
      existingOwner,
      Boolean(legacyCache || legacyEvents),
      owner
    ) !== "claim"
  )
    return
  // Record ownership first. An interrupted copy can resume for this same owner.
  await AsyncStorage.setItem(LEGACY_OWNER_KEY, owner)
  if (
    legacyCache &&
    !(await AsyncStorage.getItem(scopedKey(FEED_KEY, owner)))
  ) {
    await AsyncStorage.setItem(scopedKey(FEED_KEY, owner), legacyCache)
  }
  if (
    legacyEvents &&
    !(await AsyncStorage.getItem(scopedKey(EVENTS_KEY, owner)))
  ) {
    await AsyncStorage.setItem(scopedKey(EVENTS_KEY, owner), legacyEvents)
  }
}

/** Permanently leaves unknown legacy data unassigned before a new server is saved. */
export async function orphanLegacyData(): Promise<void> {
  const existingOwner = await AsyncStorage.getItem(LEGACY_OWNER_KEY)
  if (!existingOwner) await AsyncStorage.setItem(LEGACY_OWNER_KEY, "orphaned")
}

/** Persists an already bounded retry queue without silently discarding unsynced answers. */
export async function savePendingEvents(
  events: readonly MobilePendingEvent[],
  serverUrl?: string
): Promise<void> {
  if (events.length > MAX_PENDING_EVENTS) {
    throw new Error("Pending answer queue exceeds its storage limit")
  }
  await AsyncStorage.setItem(
    scopedKey(EVENTS_KEY, serverUrl),
    JSON.stringify(events)
  )
}

/** Creates and persists one answer event with a stable UUID. */
export function enqueueEvent(
  projectId: string,
  cardId: string,
  type: "answer",
  answer: MobileAnswer,
  serverUrl?: string
): Promise<Extract<MobilePendingEvent, { type: "answer" }>>

/** Creates and persists one passive event with a stable UUID. */
export function enqueueEvent(
  projectId: string,
  cardId: string,
  type: "skip" | "exposure",
  answer?: undefined,
  serverUrl?: string
): Promise<Extract<MobilePendingEvent, { type: "skip" | "exposure" }>>

/** Creates and persists one answer or passive event with a stable UUID. */
export async function enqueueEvent(
  projectId: string,
  cardId: string,
  type: MobilePendingEvent["type"],
  answer?: MobileAnswer,
  serverUrl?: string
): Promise<MobilePendingEvent> {
  const eventId = randomUUID()
  const occurredAt = Date.now()
  const event: MobilePendingEvent =
    type === "answer"
      ? {
          eventId,
          projectId,
          cardId,
          type,
          answer: answer as MobileAnswer,
          occurredAt,
        }
      : { eventId, projectId, cardId, type, occurredAt }
  const operation = eventMutation.then(async () => {
    const events = await loadPendingEvents(serverUrl)
    await savePendingEvents(appendPendingEvent(events, event), serverUrl)
    return event
  })
  eventMutation = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

/** Removes one successfully delivered event from the retry queue. */
export function removePendingEvent(
  eventId: string,
  serverUrl?: string
): Promise<void> {
  const operation = eventMutation.then(async () => {
    const events = await loadPendingEvents(serverUrl)
    await savePendingEvents(
      removePendingEventFromQueue(events, eventId),
      serverUrl
    )
  })
  eventMutation = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}
