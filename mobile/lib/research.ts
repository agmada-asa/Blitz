/** Owns the native adapter for approval-first research proposals and imports. */

import { randomUUID } from "expo-crypto"

import { MobileApiError } from "./api"

/** A server-suggested source that still requires explicit user approval. */
export type MobileResearchSource = {
  readonly url: string
  readonly title: string
  readonly reason: string
  readonly verification: "suggested-unverified" | "checked"
}

/** The bounded research plan shown before sources are imported. */
export type MobileResearchPlan = {
  readonly scope: string
  readonly topics: string[]
  readonly sources: MobileResearchSource[]
  readonly generatedNotes: Array<{
    readonly title: string
    readonly description: string
    readonly reason: string
  }>
}

/** The persisted planning state returned by the research service. */
export type MobileResearchSnapshot = {
  readonly proposalId: string
  readonly projectId: string
  readonly requestId: string
  readonly request: string
  readonly status: "queued" | "running" | "ready" | "failed"
  readonly proposal: MobileResearchPlan | null
  readonly error?: string
  readonly createdAt: number
  readonly updatedAt: number
}

/** The persisted state of one explicitly selected source import. */
export type MobileResearchImport = {
  readonly importId: string
  readonly proposalId: string
  readonly sourceIndex: number
  readonly status: "queued" | "running" | "imported" | "failed"
  readonly error?: string
  readonly failureCategory?: string
  readonly sourceIds: string[]
  readonly createdAt: number
  readonly updatedAt: number
}

/** Removes trailing slashes from a configured server URL. */
function base(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(value))
    throw new MobileApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  return value
}

/** Returns true when an unknown value is a JSON object. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one response without exposing an arbitrary response body to the UI. */
async function read(response: Response): Promise<unknown> {
  const text = await response.text()
  let value: unknown
  try {
    value = text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    throw new MobileApiError("Research returned an unreadable response")
  }
  if (!response.ok) {
    throw new MobileApiError(
      record(value) && typeof value.error === "string"
        ? value.error
        : `Server request failed (${response.status})`
    )
  }
  return value
}

/** Sends a bounded research request and converts network failures into retryable errors. */
async function request(
  url: string,
  init?: RequestInit & { signal?: AbortSignal }
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const abort = () => controller.abort()
  init?.signal?.addEventListener("abort", abort, { once: true })
  try {
    return await read(await fetch(url, { ...init, signal: controller.signal }))
  } catch (error) {
    if (init?.signal?.aborted) throw error
    if (controller.signal.aborted)
      throw new MobileApiError("Research request timed out. Try again.")
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not reach the research service")
  } finally {
    clearTimeout(timeout)
    init?.signal?.removeEventListener("abort", abort)
  }
}

/** Parses one suggested source while dropping malformed optional rows. */
function parseSource(value: unknown): MobileResearchSource | undefined {
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.reason !== "string"
  )
    return undefined
  return {
    url: value.url,
    title: value.title,
    reason: value.reason,
    verification:
      value.verification === "checked" ? "checked" : "suggested-unverified",
  }
}

/** Parses a persisted proposal into the native-safe response shape. */
function parseSnapshot(value: unknown): MobileResearchSnapshot | null {
  if (value === null) return null
  if (
    !record(value) ||
    typeof value.proposalId !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.request !== "string"
  )
    throw new MobileApiError("Research returned an invalid proposal")
  const rawPlan = record(value.proposal) ? value.proposal : null
  const proposal = rawPlan
    ? {
        scope: typeof rawPlan.scope === "string" ? rawPlan.scope : "",
        topics: Array.isArray(rawPlan.topics)
          ? rawPlan.topics
              .filter((topic): topic is string => typeof topic === "string")
              .slice(0, 12)
          : [],
        sources: Array.isArray(rawPlan.sources)
          ? rawPlan.sources
              .flatMap((source) => {
                const parsed = parseSource(source)
                return parsed ? [parsed] : []
              })
              .slice(0, 20)
          : [],
        generatedNotes: Array.isArray(rawPlan.generatedNotes)
          ? rawPlan.generatedNotes
              .flatMap((note) => {
                if (
                  !record(note) ||
                  typeof note.title !== "string" ||
                  typeof note.description !== "string" ||
                  typeof note.reason !== "string"
                )
                  return []
                return [
                  {
                    title: note.title,
                    description: note.description,
                    reason: note.reason,
                  },
                ]
              })
              .slice(0, 12)
          : [],
      }
    : null
  return {
    proposalId: value.proposalId,
    projectId: value.projectId,
    requestId: value.requestId,
    request: value.request,
    status:
      value.status === "running" ||
      value.status === "ready" ||
      value.status === "failed"
        ? value.status
        : "queued",
    proposal,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}

/** Parses a list of source import rows into bounded native data. */
function parseImports(value: unknown): MobileResearchImport[] {
  const rows = Array.isArray(value)
    ? value
    : record(value) && Array.isArray(value.imports)
      ? value.imports
      : []
  return rows.flatMap((row) => {
    if (
      !record(row) ||
      typeof row.importId !== "string" ||
      typeof row.proposalId !== "string" ||
      typeof row.sourceIndex !== "number"
    )
      return []
    return [
      {
        importId: row.importId,
        proposalId: row.proposalId,
        sourceIndex: row.sourceIndex,
        status:
          row.status === "running" ||
          row.status === "imported" ||
          row.status === "failed"
            ? row.status
            : "queued",
        ...(typeof row.error === "string" ? { error: row.error } : {}),
        ...(typeof row.failureCategory === "string"
          ? { failureCategory: row.failureCategory }
          : {}),
        sourceIds: Array.isArray(row.sourceIds)
          ? row.sourceIds
              .filter((id): id is string => typeof id === "string")
              .slice(0, 20)
          : [],
        createdAt: typeof row.createdAt === "number" ? row.createdAt : 0,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : 0,
      },
    ]
  })
}

/** Loads the recent proposal for a project, if one exists. */
export async function fetchLatestResearch(
  baseUrl: string,
  projectId: string,
  signal?: AbortSignal
): Promise<MobileResearchSnapshot | null> {
  const url = new URL(`${base(baseUrl)}/api/research/proposals`)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("limit", "5")
  const value = await request(url.toString(), { signal })
  if (!Array.isArray(value)) return parseSnapshot(value)
  return parseSnapshot(value[0] ?? null)
}

/** Polls one proposal by its stable request identity. */
export async function fetchResearch(
  baseUrl: string,
  projectId: string,
  requestId: string,
  signal?: AbortSignal
): Promise<MobileResearchSnapshot | null> {
  const url = new URL(`${base(baseUrl)}/api/research/proposals`)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("requestId", requestId)
  return parseSnapshot(await request(url.toString(), { signal }))
}

/** Queues a new approval-first research request with an idempotent request ID. */
export async function queueResearch(
  baseUrl: string,
  projectId: string,
  requestText: string
): Promise<MobileResearchSnapshot> {
  const response = await request(`${base(baseUrl)}/api/research/proposals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId,
      requestId: randomUUID(),
      request: requestText,
    }),
  })
  const snapshot = parseSnapshot(response)
  if (!snapshot) throw new MobileApiError("Research did not return a proposal")
  return snapshot
}

/** Retries a failed proposal using the same durable request identity. */
export async function retryResearch(
  baseUrl: string,
  projectId: string,
  requestId: string
): Promise<void> {
  await request(`${base(baseUrl)}/api/research/proposals/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, requestId }),
  })
}

/** Loads explicit import state for one ready proposal. */
export async function fetchResearchImports(
  baseUrl: string,
  projectId: string,
  requestId: string,
  signal?: AbortSignal
): Promise<MobileResearchImport[]> {
  const url = new URL(`${base(baseUrl)}/api/research/proposals/imports`)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("requestId", requestId)
  return parseImports(await request(url.toString(), { signal }))
}

/** Applies a selected subset of proposed sources and returns their import rows. */
export async function applyResearchSources(
  baseUrl: string,
  projectId: string,
  requestId: string,
  sourceIndexes: readonly number[]
): Promise<MobileResearchImport[]> {
  const value = await request(`${base(baseUrl)}/api/research/proposals/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, requestId, sourceIndexes }),
  })
  return parseImports(value)
}
