/** Adapts bounded HTTP learning requests to the server-side Convex API. */

import { ConvexHttpClient } from "convex/browser"

import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"
import type {
  AnswerRequest,
  AnswerResponse,
  EventRequest,
  EventResponse,
  FeedCard,
  FeedResponse,
  LearningAnswer,
} from "../learning/client-contracts.ts"

/** Maximum JSON request body accepted by learning routes. */
export const MAX_LEARNING_REQUEST_BYTES = 32_000

/** Maximum count and length bounds accepted for answer payloads. */
const MAX_ID_LENGTH = 128
const MAX_TEXT_ANSWER_LENGTH = 2_000
const MAX_MULTI_ANSWER_COUNT = 30
/** Longest list entry: typed program output and cloze blanks share the text limit. */
const MAX_MULTI_ANSWER_LENGTH = MAX_TEXT_ANSWER_LENGTH

/** Safe route error that carries an HTTP status without exposing backend details. */
export class LearningApiError extends Error {
  /** HTTP status appropriate for the route response. */
  readonly status: 400 | 503

  /** Creates a public-safe route error. */
  constructor(message: string, status: 400 | 503) {
    super(message)
    this.name = "LearningApiError"
    this.status = status
  }
}

/** Reads one bounded JSON request body without retaining raw request failures. */
export async function readLearningJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength && Number(declaredLength) > MAX_LEARNING_REQUEST_BYTES) {
    throw new LearningApiError("Request body is too large", 400)
  }
  let bytes: ArrayBuffer
  try {
    bytes = await request.arrayBuffer()
  } catch {
    throw new LearningApiError("Request body could not be read", 400)
  }
  if (bytes.byteLength > MAX_LEARNING_REQUEST_BYTES) {
    throw new LearningApiError("Request body is too large", 400)
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new LearningApiError("Request body must be valid JSON", 400)
  }
}

/** Requires a bounded non-empty identifier from an HTTP payload. */
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new LearningApiError(`${label} is required`, 400)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH)
    throw new LearningApiError(`${label} is invalid`, 400)
  return trimmed
}

/** Validates answer values without deciding correctness on the client boundary. */
function parseAnswer(value: unknown): LearningAnswer {
  if (typeof value === "string") {
    const answer = value.trim()
    if (!answer || answer.length > MAX_TEXT_ANSWER_LENGTH)
      throw new LearningApiError("Answer is invalid", 400)
    return answer
  }
  if (typeof value === "boolean") return value
  // Lists hold option ids, an arranged order, or typed blanks; a blank may be
  // left empty, but at least one entry must say something.
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_MULTI_ANSWER_COUNT &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length <= MAX_MULTI_ANSWER_LENGTH
    ) &&
    value.some((entry) => (entry as string).trim().length > 0)
  ) {
    return value.map((entry) => (entry as string).trim())
  }
  throw new LearningApiError("Answer is invalid", 400)
}

/** Validates and normalizes one answer request payload. */
export function parseAnswerRequest(value: unknown): AnswerRequest {
  if (!value || typeof value !== "object")
    throw new LearningApiError("Invalid answer request", 400)
  const input = value as Record<string, unknown>
  if (
    typeof input.occurredAt !== "number" ||
    !Number.isFinite(input.occurredAt)
  )
    throw new LearningApiError("Occurred time is invalid", 400)
  return {
    projectId: boundedId(input.projectId, "Project ID"),
    itemId: boundedId(input.itemId, "Item ID"),
    clientEventId: boundedId(input.clientEventId, "Client event ID"),
    occurredAt: input.occurredAt,
    answer: parseAnswer(input.answer),
  }
}

/** Validates and normalizes one passive event request payload. */
export function parseEventRequest(value: unknown): EventRequest {
  if (!value || typeof value !== "object")
    throw new LearningApiError("Invalid event request", 400)
  const input = value as Record<string, unknown>
  if (input.eventType !== "skip" && input.eventType !== "exposure")
    throw new LearningApiError("Event type is invalid", 400)
  if (
    typeof input.occurredAt !== "number" ||
    !Number.isFinite(input.occurredAt)
  )
    throw new LearningApiError("Occurred time is invalid", 400)
  return {
    projectId: boundedId(input.projectId, "Project ID"),
    itemId: boundedId(input.itemId, "Item ID"),
    clientEventId: boundedId(input.clientEventId, "Client event ID"),
    occurredAt: input.occurredAt,
    eventType: input.eventType,
  }
}

/** Creates a server-only Convex HTTP client or raises a configuration-safe error. */
function convexClient(): ConvexHttpClient {
  const url =
    process.env.BLITZ_CONVEX_URL ??
    process.env.CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) throw new LearningApiError("Learning service is unavailable", 503)
  try {
    return new ConvexHttpClient(url)
  } catch {
    throw new LearningApiError("Learning service is unavailable", 503)
  }
}

/** Item IDs remembered in a feed cursor; enough to avoid repeats within a session. */
const MAX_FEED_SEEN = 300

/** Encodes the items shown so far as an opaque cursor. */
function encodeFeedCursor(seen: string[]): string {
  return Buffer.from(JSON.stringify(seen.slice(-MAX_FEED_SEEN))).toString("base64url")
}

/** Decodes a feed cursor, rejecting anything that is not a bounded ID list. */
function decodeFeedCursor(cursor: string | undefined): string[] {
  if (!cursor) return []
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (
      Array.isArray(value) &&
      value.length <= MAX_FEED_SEEN &&
      value.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH)
    )
      return value
  } catch {
    // Fall through to the error below.
  }
  throw new LearningApiError("Feed cursor is invalid", 400)
}

/**
 * Loads one page of the Review feed: questions and recaps from units the
 * learner has started, weakest material first. The feed never ends; the
 * cursor carries the items already shown so pages do not repeat them.
 */
export async function fetchLearningFeed(input: {
  projectId?: string
  topicId?: string
  limit?: number
  cursor?: string
}): Promise<FeedResponse> {
  const limit = input.limit ?? 20
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) {
    throw new LearningApiError("Feed limit must be between 1 and 30", 400)
  }
  const projectId = input.projectId
    ? (boundedId(input.projectId, "Project ID") as Id<"projects">)
    : undefined
  const seen = decodeFeedCursor(input.cursor)
  try {
    const result = await convexClient().query(api.practice.feed, {
      projectId,
      seen,
      limit,
      now: Date.now(),
    })
    const shown = [...seen, ...result.cards.map((card) => card.id)]
    return {
      cards: result.cards as FeedCard[],
      projects: result.projects,
      topics: result.topics,
      isDone: !result.cards.length,
      continueCursor: result.cards.length ? encodeFeedCursor(shown) : null,
    }
  } catch (error) {
    if (error instanceof LearningApiError) throw error
    throw new LearningApiError("Learning service is unavailable", 503)
  }
}

/** Sends one answer to Convex for server-side scoring and feedback. */
export async function answerLearningItem(
  input: AnswerRequest
): Promise<AnswerResponse> {
  try {
    const result = await convexClient().mutation(
      api.learning.recordAnswerEvent,
      {
        projectId: input.projectId as Id<"projects">,
        itemId: input.itemId as Id<"learningItems">,
        clientEventId: input.clientEventId,
        occurredAt: input.occurredAt,
        answer: input.answer,
      }
    )
    return {
      ...result,
      eventId: result.eventId ? String(result.eventId) : null,
      feedback: result.feedback
        ? {
            ...result.feedback,
            body: result.feedback.body,
          }
        : undefined,
    } as AnswerResponse
  } catch (error) {
    if (error instanceof LearningApiError) throw error
    throw new LearningApiError("Learning service is unavailable", 503)
  }
}

/** Records skip or exposure without changing review state. */
export async function recordLearningEvent(
  input: EventRequest
): Promise<EventResponse> {
  try {
    const result = await convexClient().mutation(
      api.learning.recordPassiveEvent,
      {
        projectId: input.projectId as Id<"projects">,
        itemId: input.itemId as Id<"learningItems">,
        clientEventId: input.clientEventId,
        occurredAt: input.occurredAt,
        eventType: input.eventType,
      }
    )
    return {
      eventId: String(result.eventId),
      alreadyRecorded: result.alreadyRecorded,
      eventType: result.eventType,
    }
  } catch (error) {
    if (error instanceof LearningApiError) throw error
    throw new LearningApiError("Learning service is unavailable", 503)
  }
}

/** Keeps the imported feed type visible to callers that inspect this adapter boundary. */
export type { FeedCard }
