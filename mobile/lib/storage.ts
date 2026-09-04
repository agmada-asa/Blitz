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

const FEED_KEY = "@blitz/mobile/feed-v1"
const EVENTS_KEY = "@blitz/mobile/events-v1"
const SERVER_URL_KEY = "@blitz/mobile/server-url-v1"
const MAX_CACHED_ITEMS = 60
let eventMutation = Promise.resolve()

/** The persisted cache envelope, versioned for safe future migrations. */
export type MobileFeedCache = {
  readonly version: 1
  readonly savedAt: number
  readonly payload: MobileFeedPayload
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
export async function loadFeedCache(): Promise<MobileFeedCache | undefined> {
  const value = await readJson<MobileFeedCache>(FEED_KEY)
  if (value?.version !== 1 || !value.payload || !Array.isArray(value.payload.cards)) {
    return undefined
  }
  return value
}

/** Stores only the first bounded slice of a prepared feed for offline use. */
export async function saveFeedCache(payload: MobileFeedPayload): Promise<void> {
  const cache: MobileFeedCache = {
    version: 1,
    savedAt: Date.now(),
    payload: { ...payload, cards: payload.cards.slice(0, MAX_CACHED_ITEMS) },
  }
  await AsyncStorage.setItem(FEED_KEY, JSON.stringify(cache))
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
export async function loadPendingEvents(): Promise<MobilePendingEvent[]> {
  const value = await readJson<MobilePendingEvent[]>(EVENTS_KEY)
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

/** Persists an already bounded retry queue without silently discarding unsynced answers. */
export async function savePendingEvents(events: readonly MobilePendingEvent[]): Promise<void> {
  if (events.length > MAX_PENDING_EVENTS) {
    throw new Error("Pending answer queue exceeds its storage limit")
  }
  await AsyncStorage.setItem(EVENTS_KEY, JSON.stringify(events))
}

/** Creates and persists one answer event with a stable UUID. */
export function enqueueEvent(
  projectId: string,
  cardId: string,
  type: "answer",
  answer: MobileAnswer
): Promise<Extract<MobilePendingEvent, { type: "answer" }>>

/** Creates and persists one passive event with a stable UUID. */
export function enqueueEvent(
  projectId: string,
  cardId: string,
  type: "skip" | "exposure"
): Promise<Extract<MobilePendingEvent, { type: "skip" | "exposure" }>>

/** Creates and persists one answer or passive event with a stable UUID. */
export async function enqueueEvent(
  projectId: string,
  cardId: string,
  type: MobilePendingEvent["type"],
  answer?: MobileAnswer
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
    const events = await loadPendingEvents()
    await savePendingEvents(appendPendingEvent(events, event))
    return event
  })
  eventMutation = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}

/** Removes one successfully delivered event from the retry queue. */
export function removePendingEvent(eventId: string): Promise<void> {
  const operation = eventMutation.then(async () => {
    const events = await loadPendingEvents()
    await savePendingEvents(removePendingEventFromQueue(events, eventId))
  })
  eventMutation = operation.then(
    () => undefined,
    () => undefined
  )
  return operation
}
