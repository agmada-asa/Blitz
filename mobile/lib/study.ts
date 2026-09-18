/** Owns the native adapter for the shared deliberate study-session contract. */

import type {
  SessionAnswerResult,
  SessionQuestion,
  SessionQuestionPage,
  SessionAnswerSubmission,
} from "../../lib/learning/session-contracts"
import { MobileApiError } from "./api"

/** Removes trailing slashes and rejects an unusable native server address. */
function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(normalized))
    throw new MobileApiError("Enter a valid Blitz server URL")
  return normalized
}

/** Returns true for a response value that can be inspected as an object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads a required bounded string from an untrusted session response. */
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new MobileApiError(`Server response is missing ${label}`)
  return value
}

/** Parses one answer option without allowing server data to alter native state. */
function parseOption(value: unknown): { id: string; text: string } {
  if (!isRecord(value)) throw new MobileApiError("Invalid session option")
  return {
    id: requiredString(value.id, "option id"),
    text: requiredString(value.text, "option text"),
  }
}

/** Parses one question that is safe to render before scoring. */
function parseQuestion(value: unknown): SessionQuestion {
  if (!isRecord(value)) throw new MobileApiError("Invalid session question")
  const type = requiredString(value.type, "question type")
  if (
    type !== "single-choice" &&
    type !== "multiple-answer" &&
    type !== "true-false"
  )
    throw new MobileApiError("Unsupported session question type")
  return {
    itemId: requiredString(value.itemId, "question id"),
    conceptId: requiredString(value.conceptId, "concept id"),
    ...(typeof value.topicId === "string" ? { topicId: value.topicId } : {}),
    type,
    title: requiredString(value.title, "question title"),
    prompt: requiredString(value.prompt, "question prompt"),
    ...(Array.isArray(value.options)
      ? { options: value.options.map(parseOption) }
      : {}),
    ...(typeof value.order === "number" ? { order: value.order } : {}),
  }
}

/** Parses the bounded deck response returned by the learning route. */
function parseSessionPage(value: unknown): SessionQuestionPage {
  if (!isRecord(value) || !Array.isArray(value.items))
    throw new MobileApiError("Server returned an invalid question deck")
  if (typeof value.isDone !== "boolean")
    throw new MobileApiError("Server returned incomplete deck metadata")
  return {
    items: value.items.map(parseQuestion),
    isDone: value.isDone,
    continueCursor:
      typeof value.continueCursor === "string" ? value.continueCursor : "",
  }
}

/** Parses the server-owned result without attempting local correctness checks. */
function parseAnswerResult(value: unknown): SessionAnswerResult {
  if (!isRecord(value))
    throw new MobileApiError("Server returned an invalid answer result")
  if (
    (value.status !== "correct" &&
      value.status !== "incorrect" &&
      value.status !== "invalid") ||
    typeof value.isCorrect !== "boolean"
  )
    throw new MobileApiError("Server returned an incomplete answer result")
  return {
    attemptId: requiredString(value.attemptId, "attempt id"),
    itemId: requiredString(value.itemId, "item id"),
    status: value.status,
    isCorrect: value.isCorrect,
    ...(typeof value.alreadyRecorded === "boolean"
      ? { alreadyRecorded: value.alreadyRecorded }
      : {}),
    ...(isRecord(value.feedback)
      ? {
          feedback: {
            ...(typeof value.feedback.body === "string"
              ? { body: value.feedback.body }
              : {}),
            ...(typeof value.feedback.correctOptionId === "string"
              ? { correctOptionId: value.feedback.correctOptionId }
              : {}),
            ...(Array.isArray(value.feedback.correctOptionIds)
              ? {
                  correctOptionIds: value.feedback.correctOptionIds.filter(
                    (id): id is string => typeof id === "string"
                  ),
                }
              : {}),
            ...(typeof value.feedback.correctAnswer === "boolean"
              ? { correctAnswer: value.feedback.correctAnswer }
              : {}),
          },
        }
      : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  }
}

/** Reads a JSON response and converts transport failures into recoverable copy. */
async function readJson(response: Response): Promise<unknown> {
  const body = await response.text()
  let value: unknown
  try {
    value = body ? (JSON.parse(body) as unknown) : undefined
  } catch {
    throw new MobileApiError("Server returned an unreadable response")
  }
  if (!response.ok) {
    const message =
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : `Server request failed (${response.status})`
    throw new MobileApiError(message)
  }
  return value
}

/** Loads one project and topic-scoped question deck from the shared route. */
export async function fetchStudySession(
  baseUrl: string,
  projectId: string,
  topicId?: string,
  signal?: AbortSignal
): Promise<SessionQuestionPage> {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/api/learning/session`)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("limit", "20")
  if (topicId) url.searchParams.set("topicId", topicId)
  try {
    const response = await fetch(url, { signal })
    return parseSessionPage(await readJson(response))
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new MobileApiError("Could not reach the learning server")
  }
}

/** Submits one deliberate answer while preserving the web idempotency fields. */
export async function submitStudyAnswer(
  baseUrl: string,
  projectId: string,
  submission: SessionAnswerSubmission
): Promise<SessionAnswerResult> {
  try {
    const response = await fetch(
      `${normalizeBaseUrl(baseUrl)}/api/learning/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          itemId: submission.itemId,
          attemptId: submission.attemptId,
          occurredAt: submission.occurredAt,
          answer: submission.answer,
        }),
      }
    )
    return parseAnswerResult(await readJson(response))
  } catch (error) {
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not save that answer")
  }
}
