/**
 * Owns the fetch adapter for the shared learning routes. It performs no local
 * scoring and turns unavailable servers into retryable errors so cached cards
 * remain usable without losing events.
 */

import type {
  AnswerResponse,
  FeedCard,
  FeedResponse,
  LearningAnswer,
} from "../../lib/learning/client-contracts"
import type {
  MobileAnswerResult,
  MobileFeedPayload,
  MobileLearningCard,
  MobilePendingEvent,
} from "./contracts"

const REQUEST_TIMEOUT_MS = 12_000

/** Error raised when the configured service cannot be reached or parsed. */
export class MobileApiError extends Error {
  /** Creates a safe error that omits response bodies and source contents. */
  constructor(message: string) {
    super(message)
    this.name = "MobileApiError"
  }
}

/** Metadata returned after an Android or browser client stores original bytes. */
export type MobileOriginalUpload = {
  readonly key: string
  readonly sha256: string
  readonly size: number
  readonly mimeType: string | null
  readonly filename: string
  readonly duplicate: boolean
}

/** Removes trailing slashes so endpoint joins remain stable. */
function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(normalized)) {
    throw new MobileApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  }
  return normalized
}

/** Bounds one native request and forwards caller cancellation to its signal. */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const callerSignal = init?.signal
  const abortCaller = () => controller.abort()
  callerSignal?.addEventListener("abort", abortCaller, { once: true })
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener("abort", abortCaller)
  }
}

/** Parses a JSON response while providing a consistent transport error. */
async function readJson(response: Response): Promise<unknown> {
  const body = await response.text()
  if (!response.ok) {
    throw new MobileApiError(`Server request failed (${response.status})`)
  }
  try {
    return body ? (JSON.parse(body) as unknown) : undefined
  } catch {
    throw new MobileApiError("Server returned an unreadable response")
  }
}

/** Returns true when an unknown value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads a required non-empty string from an unknown API value. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MobileApiError(`Server response is missing ${field}`)
  }
  return value
}

/** Uploads one original source stream to the local Mac storage boundary. */
export async function uploadOriginalSource(
  baseUrl: string,
  input: {
    projectId: string
    filename: string
    mimeType?: string
    body: BodyInit
    signal?: AbortSignal
  }
): Promise<MobileOriginalUpload> {
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(baseUrl)}/api/sources/upload`,
    {
      method: "POST",
      headers: {
        "x-blitz-project-id": input.projectId,
        "x-blitz-filename": input.filename,
        ...(input.mimeType ? { "content-type": input.mimeType } : {}),
      },
      body: input.body,
      signal: input.signal,
    }
  )
  const value = await readJson(response)
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid upload response")
  return {
    key: requiredString(value.key, "upload key"),
    sha256: requiredString(value.sha256, "upload hash"),
    size: typeof value.size === "number" ? value.size : 0,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : null,
    filename: requiredString(value.filename, "upload filename"),
    duplicate: value.duplicate === true,
  }
}

/** Validates one option from the shared feed response. */
function parseOption(value: unknown): { id: string; text: string } {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid option")
  return {
    id: requiredString(value.id, "option id"),
    text: requiredString(value.text, "option text"),
  }
}

/** Card formats this app can render; a newer server may send others. */
const SUPPORTED_CARD_TYPES: ReadonlySet<string> = new Set<MobileLearningCard["type"]>([
  "explain",
  "single-choice",
  "multiple-answer",
  "true-false",
  "cloze",
  "ordering",
  "matching",
  "code-output",
])

/**
 * Validates a feed card while retaining no server-owned answer fields.
 * Returns null for a format this app cannot render, so one new card type
 * from a newer server does not empty the whole feed.
 */
function parseCard(value: unknown): MobileLearningCard | null {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid card")
  const type = requiredString(value.type, "card type")
  if (!SUPPORTED_CARD_TYPES.has(type)) return null
  const card: Record<string, unknown> = {
    id: requiredString(value.id, "card id"),
    projectId: requiredString(value.projectId, "project id"),
    conceptId: requiredString(value.conceptId, "concept id"),
    title: requiredString(value.title, "card title"),
    sourceLabel: typeof value.sourceLabel === "string" ? value.sourceLabel : "",
    sourceIds: Array.isArray(value.sourceIds)
      ? value.sourceIds.map((id) => requiredString(id, "source id"))
      : [],
    type,
  }
  if (typeof value.topicId === "string") card.topicId = value.topicId
  // Repeated cards in a later feed round share an id but carry a new key.
  if (typeof value.key === "string") card.key = value.key
  if (type === "explain") {
    card.body = requiredString(value.body, "card body")
  } else {
    card.question = requiredString(value.question, "card question")
    if (value.options !== undefined) {
      if (!Array.isArray(value.options))
        throw new MobileApiError("Server returned invalid options")
      card.options = value.options.map(parseOption)
    }
    if (Array.isArray(value.prompts))
      card.prompts = value.prompts.map((prompt) => requiredString(prompt, "matching item"))
  }
  return card as MobileLearningCard
}

/** Validates a filter choice from the shared feed response. */
function parseChoice(
  value: unknown,
  label: string
): { id: string; title: string } {
  if (!isRecord(value))
    throw new MobileApiError(`Server returned an invalid ${label}`)
  return {
    id: requiredString(value.id, `${label} id`),
    title: requiredString(value.title, `${label} title`),
  }
}

/** Validates the exact shared feed response shape. */
function parseFeed(value: unknown): MobileFeedPayload {
  if (!isRecord(value) || !Array.isArray(value.cards)) {
    throw new MobileApiError("Server returned an invalid learning feed")
  }
  if (!Array.isArray(value.projects) || !Array.isArray(value.topics)) {
    throw new MobileApiError("Server returned incomplete feed filters")
  }
  return {
    cards: value.cards
      .map(parseCard)
      .filter((card): card is MobileLearningCard => card !== null),
    projects: value.projects.map((choice) => parseChoice(choice, "project")),
    topics: value.topics.map((choice) => {
      const parsed = parseChoice(choice, "topic")
      if (!isRecord(choice) || typeof choice.projectId !== "string") {
        throw new MobileApiError("Server returned an invalid topic project")
      }
      return { ...parsed, projectId: choice.projectId }
    }),
    isDone: value.isDone === true,
    continueCursor:
      typeof value.continueCursor === "string" ? value.continueCursor : null,
  }
}

/** Requests a prepared feed for the selected project/topic filters. */
export async function fetchFeed(
  baseUrl: string,
  filters: {
    projectId?: string
    topicId?: string
    cursor?: string
    signal?: AbortSignal
  }
): Promise<MobileFeedPayload> {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/learning/feed`)
  url.searchParams.set("limit", "20")
  if (filters.projectId) url.searchParams.set("projectId", filters.projectId)
  if (filters.topicId) url.searchParams.set("topicId", filters.topicId)
  if (filters.cursor) url.searchParams.set("cursor", filters.cursor)
  try {
    const response = await fetchWithTimeout(url, { signal: filters.signal })
    return parseFeed(await readJson(response))
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not reach the learning server")
  }
}

/** Extracts a server-scored response without deciding correctness locally. */
function parseAnswerResult(value: unknown): MobileAnswerResult {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid answer response")
  if (
    (value.status !== "correct" &&
      value.status !== "incorrect" &&
      value.status !== "invalid") ||
    typeof value.isCorrect !== "boolean"
  ) {
    throw new MobileApiError("Server returned an incomplete answer response")
  }
  return value as unknown as AnswerResponse
}

/** Sends an answer to POST /api/learning/answer using the shared field names. */
export async function submitAnswer(
  baseUrl: string,
  event: Extract<MobilePendingEvent, { type: "answer" }>
): Promise<MobileAnswerResult> {
  const response = await postJson<unknown>(baseUrl, "/api/learning/answer", {
    projectId: event.projectId,
    itemId: event.cardId,
    clientEventId: event.eventId,
    occurredAt: event.occurredAt,
    answer: event.answer,
  })
  return parseAnswerResult(response)
}

/** Sends a skip or exposure event using the shared event request contract. */
export async function submitPassiveEvent(
  baseUrl: string,
  event: Extract<MobilePendingEvent, { type: "skip" | "exposure" }>
): Promise<void> {
  await postJson(baseUrl, "/api/learning/event", {
    projectId: event.projectId,
    itemId: event.cardId,
    clientEventId: event.eventId,
    occurredAt: event.occurredAt,
    eventType: event.type,
  })
}

/** Posts one bounded JSON payload and parses its response. */
async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<T> {
  try {
    const response = await fetchWithTimeout(
      `${normalizeBaseUrl(baseUrl)}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    )
    return (await readJson(response)) as T
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not reach the learning server")
  }
}

/** Keeps shared answer type visible at the adapter boundary for future callers. */
export type { FeedCard, FeedResponse, LearningAnswer }
