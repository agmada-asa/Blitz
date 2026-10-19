/**
 * Keeps the Teach, Practice, and Home screens usable when the phone cannot
 * reach the computer running Blitz: the latest Today page, library, module
 * pages, and every opened lesson are saved on the device and shown with an
 * offline notice, and lesson quiz answers made offline wait in a queue until
 * the server is back. Drill answers use the feed's existing queue
 * (`enqueueEvent` in `./storage`), because they go to the same route.
 *
 * Everything is scoped to the server URL, so two computers never mix data.
 */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { randomUUID } from "expo-crypto"

import { answerTeachQuiz } from "./learning-api"

/** Saved lessons kept on the device; the oldest is dropped beyond this. */
const MAX_SAVED_LESSONS = 30

/** Prefix for every key this module owns. */
const PREFIX = "@blitz/mobile/learn-v1"

/** A saved payload and when it was saved. */
export type Cached<T> = { readonly savedAt: number; readonly value: T }

/** One lesson quiz answer waiting to be recorded. */
export type QueuedTeachAnswer = {
  readonly id: string
  readonly chatId: string
  readonly messageId: string
  readonly quizId: string
  readonly selectedOptionIds: string[]
  readonly queuedAt: number
}

/** Builds a storage key scoped to one server. */
function key(serverUrl: string, name: string): string {
  return `${PREFIX}:${encodeURIComponent(serverUrl.trim().replace(/\/+$/, ""))}:${name}`
}

/** Reads a saved payload, or undefined when none is saved or it is unreadable. */
export async function loadCached<T>(serverUrl: string, name: string): Promise<Cached<T> | undefined> {
  try {
    const raw = await AsyncStorage.getItem(key(serverUrl, name))
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Cached<T>
    return typeof parsed?.savedAt === "number" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Saves a payload. Lessons (`teach:<unitId>`) are also recorded in a bounded
 * index so the oldest saved lesson is removed once there are too many.
 * Storage failures are ignored: the cache is a convenience, never the source
 * of truth.
 */
export async function saveCached<T>(serverUrl: string, name: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key(serverUrl, name), JSON.stringify({ savedAt: Date.now(), value }))
    if (!name.startsWith("teach:")) return
    const indexKey = key(serverUrl, "teach-index")
    const index = (JSON.parse((await AsyncStorage.getItem(indexKey)) ?? "[]") as string[]).filter(
      (entry) => entry !== name
    )
    index.unshift(name)
    const dropped = index.splice(MAX_SAVED_LESSONS)
    await AsyncStorage.setItem(indexKey, JSON.stringify(index))
    if (dropped.length) await AsyncStorage.multiRemove(dropped.map((entry) => key(serverUrl, entry)))
  } catch {
    // A full or unavailable store only means less is available offline.
  }
}

/** Reads the queue of lesson quiz answers waiting to be recorded. */
export async function loadTeachAnswerQueue(serverUrl: string): Promise<QueuedTeachAnswer[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(key(serverUrl, "teach-answers"))) ?? "[]") as QueuedTeachAnswer[]
  } catch {
    return []
  }
}

/** Adds a lesson quiz answer to the queue. */
export async function queueTeachAnswer(
  serverUrl: string,
  answer: Omit<QueuedTeachAnswer, "id" | "queuedAt">
): Promise<void> {
  const queue = await loadTeachAnswerQueue(serverUrl)
  // One answer per quiz: the first one counts, as when answering online.
  if (queue.some((entry) => entry.messageId === answer.messageId && entry.quizId === answer.quizId)) return
  queue.push({ ...answer, id: randomUUID(), queuedAt: Date.now() })
  await AsyncStorage.setItem(key(serverUrl, "teach-answers"), JSON.stringify(queue.slice(-200)))
}

/**
 * Records queued lesson quiz answers in order, stopping at the first one the
 * server cannot be reached for. Answers the server rejects (for example a
 * quiz from a session that was restarted) are dropped rather than retried
 * forever.
 * @returns How many answers are still waiting.
 */
export async function flushTeachAnswers(serverUrl: string): Promise<number> {
  const queue = await loadTeachAnswerQueue(serverUrl)
  let index = 0
  for (; index < queue.length; index++) {
    const entry = queue[index]
    try {
      await answerTeachQuiz(serverUrl, entry)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      // Unreachable server: keep this and later answers for next time.
      if (/reach|unreadable|\(5\d\d\)/i.test(message)) break
    }
  }
  const remaining = queue.slice(index)
  await AsyncStorage.setItem(key(serverUrl, "teach-answers"), JSON.stringify(remaining)).catch(() => undefined)
  return remaining.length
}
