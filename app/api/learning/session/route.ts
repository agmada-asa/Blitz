/**
 * Provides the bounded study and test session HTTP contract.
 *
 * GET returns question-only deck pages. POST forwards one answer to the
 * existing server-scored learning mutation and uses the stable attempt ID as
 * its idempotency key, so a native or browser client can retry safely.
 */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  LearningApiError,
  answerLearningItem,
  readLearningJson,
} from "@/lib/server/learning-api"
import type {
  SessionAnswer,
  SessionAnswerResult,
  SessionQuestion,
  SessionQuestionPage,
} from "@/lib/learning/session-contracts"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Maximum page size accepted by the deliberate-session route. */
const MAX_PAGE_SIZE = 20

/** Returns a compact non-empty request identifier. */
function requiredId(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new LearningApiError(`${label} is required`, 400)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 400)
    throw new LearningApiError(`${label} is invalid`, 400)
  return trimmed
}

/** Parses scalar and multiple-choice answer values without scoring them. */
function parseSessionAnswer(value: unknown): SessionAnswer {
  if (typeof value === "string") {
    const answer = value.trim()
    if (!answer || answer.length > 2_000)
      throw new LearningApiError("Answer is invalid", 400)
    return answer
  }
  if (typeof value === "boolean") return value
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 30 &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.trim().length > 0 &&
        entry.trim().length <= 128
    )
  )
    return value.map((entry) => (entry as string).trim())
  throw new LearningApiError("Answer is invalid", 400)
}

/** Creates a server-only Convex client for the configured local deployment. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(
    () => new LearningApiError("Learning service is unavailable", 503)
  )
}

/** Parses a bounded answer submission and maps its attempt ID to the event key. */
async function parseSubmission(request: Request): Promise<{
  projectId: string
  itemId: string
  clientEventId: string
  occurredAt: number
  answer: SessionAnswer
}> {
  const body = await readLearningJson(request)
  if (!body || typeof body !== "object")
    throw new LearningApiError("Session answer is invalid", 400)
  const input = body as Record<string, unknown>
  if (
    typeof input.occurredAt !== "number" ||
    !Number.isFinite(input.occurredAt)
  )
    throw new LearningApiError("Occurred time is invalid", 400)
  return {
    projectId: requiredId(input.projectId, "Project ID"),
    itemId: requiredId(input.itemId, "Item ID"),
    clientEventId: requiredId(input.attemptId, "Attempt ID"),
    occurredAt: input.occurredAt,
    answer: parseSessionAnswer(input.answer),
  }
}

/**
 * Returns up to twenty question items without exposing answer keys.
 *
 * The Convex query performs one pagination operation. This adapter follows
 * up to ten cursors to fill a sparse page after explanation rows or filters,
 * keeping each backend query bounded and avoiding a dropped page boundary.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const rawLimit = url.searchParams.get("limit")
    const limit = rawLimit === null ? MAX_PAGE_SIZE : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
      throw new LearningApiError("Session limit must be between 1 and 20", 400)
    const projectId = requiredId(
      url.searchParams.get("projectId"),
      "Project ID"
    )
    const topicValue = url.searchParams.get("topicId")
    const cursor = url.searchParams.get("cursor")
    const topicId = topicValue
      ? (requiredId(topicValue, "Topic ID") as Id<"topics">)
      : undefined
    const client = convexClient()
    const items: SessionQuestion[] = []
    let nextCursor: string | null = cursor || null
    let isDone = false
    let continueCursor = cursor ?? ""
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = (await client.query(api.study.listStudyQuestions, {
        projectId: projectId as Id<"projects">,
        ...(topicId ? { topicId } : {}),
        paginationOpts: {
          numItems: Math.min(limit - items.length, MAX_PAGE_SIZE),
          cursor: nextCursor,
        },
      })) as SessionQuestionPage
      items.push(...page.items)
      isDone = page.isDone
      continueCursor = page.continueCursor
      if (isDone || items.length >= limit) break
      nextCursor = page.continueCursor
    }
    return Response.json({ items, isDone, continueCursor })
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Learning service is unavailable" },
      { status: 503 }
    )
  }
}

/** Scores one answer and returns feedback only after the server accepts it. */
export async function POST(request: Request): Promise<Response> {
  try {
    const input = await parseSubmission(request)
    const serverAnswer: string | boolean | string[] =
      typeof input.answer === "string" || typeof input.answer === "boolean"
        ? input.answer
        : Array.from(input.answer)
    const result = (await answerLearningItem({
      ...input,
      answer: serverAnswer,
    })) as SessionAnswerResult & {
      eventId?: string | null
    }
    return Response.json({
      attemptId: input.clientEventId,
      itemId: input.itemId,
      status: result.status,
      isCorrect: result.isCorrect,
      alreadyRecorded: result.alreadyRecorded,
      feedback: result.feedback,
      reason: result.reason,
    } satisfies SessionAnswerResult)
  } catch (error) {
    if (error instanceof LearningApiError)
      return Response.json({ error: error.message }, { status: error.status })
    return Response.json(
      { error: "Learning service is unavailable" },
      { status: 503 }
    )
  }
}
