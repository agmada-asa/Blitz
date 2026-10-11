/**
 * Talks to the routes behind the native Teach, Practice, and Home screens
 * (`lib/learning/mobile-contracts.ts`), and to the shared desktop routes for
 * Teach turns (`/api/chat`), pausing a reply (`/api/chat/pause`), and lesson
 * quiz answers (`/api/teach/answer`). Drill answers use `submitAnswer` in
 * `./api`, the same route as the feed.
 *
 * Every request is bounded by a timeout and turns failures into
 * `MobileApiError` messages that are safe to show.
 */

import { fetch as streamingFetch } from "expo/fetch"
import { randomUUID } from "expo-crypto"

import type {
  MobileDrillResponse,
  MobileHomeResponse,
  MobileLibraryResponse,
  MobileModuleResponse,
  MobileSessionSummary,
  MobileTeachResponse,
  MobileTeachStartResponse,
} from "../../lib/learning/mobile-contracts"
import { readChatStream } from "../../lib/chat-stream"
import { MobileApiError } from "./api"

/** Ordinary requests give up after this long; Teach turns stream for longer. */
const REQUEST_TIMEOUT_MS = 15_000

/** Removes trailing slashes so paths join cleanly. */
function base(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

/** Returns the device's time zone offset, so days follow its midnight. */
function timezoneOffset(): number {
  return new Date().getTimezoneOffset()
}

/**
 * Sends one JSON request and returns its parsed body.
 * @throws MobileApiError with the server's message, or a generic one.
 */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
      signal: controller.signal,
    })
  } catch {
    throw new MobileApiError("Could not reach Blitz on your computer")
  } finally {
    clearTimeout(timeout)
  }
  const text = await response.text()
  let value: unknown
  try {
    value = text ? JSON.parse(text) : undefined
  } catch {
    throw new MobileApiError("Blitz sent an unreadable response")
  }
  if (!response.ok) {
    const message =
      value && typeof value === "object" && "error" in value && typeof value.error === "string"
        ? value.error
        : `Blitz could not answer (${response.status})`
    throw new MobileApiError(message)
  }
  return value as T
}

/** Loads the Today page: XP, streak, week, and the unit to resume. */
export function fetchHome(baseUrl: string): Promise<MobileHomeResponse> {
  return request(`${base(baseUrl)}/api/mobile/home?tz=${timezoneOffset()}`)
}

/** Loads every module with its progress. */
export function fetchLibrary(baseUrl: string): Promise<MobileLibraryResponse> {
  return request(`${base(baseUrl)}/api/mobile/modules`)
}

/** Loads one module's learning path, practice, and papers. */
export function fetchModule(baseUrl: string, projectId: string): Promise<MobileModuleResponse> {
  return request(`${base(baseUrl)}/api/mobile/modules/${encodeURIComponent(projectId)}`)
}

/** Loads a unit's Teach session. */
export function fetchTeach(baseUrl: string, unitId: string): Promise<MobileTeachResponse> {
  return request(`${base(baseUrl)}/api/mobile/teach?unitId=${encodeURIComponent(unitId)}`)
}

/** Opens a unit's Teach session, or restarts it, and returns its chat id. */
export function startTeach(
  baseUrl: string,
  unitId: string,
  restart = false
): Promise<MobileTeachStartResponse> {
  return request(`${base(baseUrl)}/api/mobile/teach`, {
    method: "POST",
    body: JSON.stringify({ unitId, restart }),
  })
}

/** Loads an adaptive drill for a module, or one unit of it. */
export function fetchDrill(
  baseUrl: string,
  projectId: string,
  unitId?: string
): Promise<MobileDrillResponse> {
  const unit = unitId ? `&unitId=${encodeURIComponent(unitId)}` : ""
  return request(`${base(baseUrl)}/api/mobile/drill?projectId=${encodeURIComponent(projectId)}${unit}`)
}

/** Loads what a session added up to since `since`. */
export function fetchSummary(
  baseUrl: string,
  input: { projectId: string; unitId?: string; since: number }
): Promise<MobileSessionSummary> {
  const unit = input.unitId ? `&unitId=${encodeURIComponent(input.unitId)}` : ""
  return request(
    `${base(baseUrl)}/api/mobile/summary?projectId=${encodeURIComponent(input.projectId)}${unit}&since=${input.since}&tz=${timezoneOffset()}`
  )
}

/**
 * Sends one Teach turn through the shared chat route and waits for the reply
 * to finish. The reply's text is read by polling `fetchTeach`, as the desktop
 * reads it from the database, so this only watches for errors.
 * @throws MobileApiError when the turn cannot start or fails; an AbortError
 * when `signal` aborts.
 */
export async function sendTeachTurn(
  baseUrl: string,
  input: { chatId: string; message: string; continuationOf?: string },
  signal: AbortSignal
): Promise<void> {
  let response: Awaited<ReturnType<typeof streamingFetch>>
  try {
    response = await streamingFetch(`${base(baseUrl)}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        chatId: input.chatId,
        message: input.message,
        clientMessageId: randomUUID(),
        projectIds: [],
        attachments: [],
        ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}),
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new MobileApiError("Blitz could not reach the tutor. Try again.")
  }
  if (!response.ok || !response.body) {
    const value = (await response.json().catch(() => null)) as { error?: unknown } | null
    throw new MobileApiError(
      typeof value?.error === "string" ? value.error : "The tutor could not start. Try again."
    )
  }
  let failure: string | undefined
  try {
    await readChatStream(response.body as ReadableStream<Uint8Array>, (value) => {
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "error" &&
        "message" in value &&
        typeof value.message === "string"
      )
        failure = value.message
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new MobileApiError("The connection to the tutor dropped. The reply may still finish.")
  }
  if (failure) throw new MobileApiError(failure)
}

/** Pauses the reply being written; the saved text stays and can be continued. */
export async function pauseTeachTurn(baseUrl: string, chatId: string, messageId: string): Promise<void> {
  await request(`${base(baseUrl)}/api/chat/pause`, {
    method: "POST",
    body: JSON.stringify({ chatId, messageId }),
  })
}

/**
 * Records an answer to a lesson quiz. The server re-reads the quiz from the
 * saved reply and scores it, so this only names the quiz and the answer.
 * @param selectedOptionIds Chosen option ids, or typed answers for cloze and
 * code output, as the desktop quiz sends them.
 * @returns Whether the server scored the answer correct.
 */
export async function answerTeachQuiz(
  baseUrl: string,
  input: { chatId: string; messageId: string; quizId: string; selectedOptionIds: string[] }
): Promise<{ correct: boolean }> {
  const value = await request<{ correct?: unknown }>(`${base(baseUrl)}/api/teach/answer`, {
    method: "POST",
    body: JSON.stringify({ ...input, clientEventId: randomUUID() }),
  })
  if (typeof value.correct !== "boolean") throw new MobileApiError("Your answer could not be saved.")
  return { correct: value.correct }
}
