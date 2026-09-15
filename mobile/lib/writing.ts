/** Owns the native HTTP adapter for persisted written-practice activities. */

import { randomUUID } from "expo-crypto"

import { MobileApiError } from "./api"

/** Public written activity item returned by the server. */
export type MobileWritingItem = {
  readonly itemId: string
  readonly title: string
  readonly prompt: string
  readonly sourceLabels: string[]
  readonly answer?: string
  readonly revealed: boolean
  readonly reference?: string
}

/** Native-safe persisted written activity shape. */
export type MobileWritingActivity = {
  readonly _id: string
  readonly projectId: string
  readonly topicId?: string
  readonly status: "active" | "completed"
  readonly items: MobileWritingItem[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Removes trailing slashes from a configured server URL. */
function base(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

/** Returns true for an object that can be parsed field by field. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validates a bounded native writing response. */
function parseActivity(value: unknown): MobileWritingActivity | null {
  if (value === null) return null
  if (
    !record(value) ||
    typeof value._id !== "string" ||
    !Array.isArray(value.items)
  )
    throw new MobileApiError("Server returned an invalid written activity")
  return {
    _id: value._id,
    projectId: typeof value.projectId === "string" ? value.projectId : "",
    ...(typeof value.topicId === "string" ? { topicId: value.topicId } : {}),
    status: value.status === "completed" ? "completed" : "active",
    items: value.items.flatMap((item) => {
      if (
        !record(item) ||
        typeof item.itemId !== "string" ||
        typeof item.prompt !== "string"
      )
        return []
      return [
        {
          itemId: item.itemId,
          title: typeof item.title === "string" ? item.title : item.prompt,
          prompt: item.prompt,
          sourceLabels: Array.isArray(item.sourceLabels)
            ? item.sourceLabels.filter(
                (label): label is string => typeof label === "string"
              )
            : [],
          ...(typeof item.answer === "string" ? { answer: item.answer } : {}),
          revealed: item.revealed === true,
          ...(typeof item.reference === "string"
            ? { reference: item.reference }
            : {}),
        },
      ]
    }),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

/** Reads JSON and reports server-provided safe error copy. */
async function read(response: Response): Promise<unknown> {
  const text = await response.text()
  let value: unknown
  try {
    value = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    throw new MobileApiError("Server returned an unreadable response")
  }
  if (!response.ok)
    throw new MobileApiError(
      record(value) && typeof value.error === "string"
        ? value.error
        : `Server request failed (${response.status})`
    )
  return value
}

/** Loads the latest activity for one project and optional topic. */
export async function fetchWritingActivity(
  baseUrl: string,
  projectId: string,
  topicId?: string
): Promise<MobileWritingActivity | null> {
  const url = new URL(`${base(baseUrl)}/api/mobile/writing`)
  url.searchParams.set("projectId", projectId)
  if (topicId) url.searchParams.set("topicId", topicId)
  return parseActivity(await read(await fetch(url)))
}

/** Starts or resumes one persisted writing activity. */
export async function startWritingActivity(
  baseUrl: string,
  projectId: string,
  topicId?: string
): Promise<MobileWritingActivity | null> {
  return parseActivity(
    await read(
      await fetch(`${base(baseUrl)}/api/mobile/writing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          projectId,
          topicId,
          requestId: randomUUID(),
        }),
      })
    )
  )
}

/** Saves a draft or reveals the server reference for one written prompt. */
export async function saveWritingAnswer(
  baseUrl: string,
  input: {
    projectId: string
    activityId: string
    itemId: string
    answer: string
    reveal: boolean
  }
): Promise<MobileWritingActivity | null> {
  return parseActivity(
    await read(
      await fetch(`${base(baseUrl)}/api/mobile/writing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", ...input }),
      })
    )
  )
}
