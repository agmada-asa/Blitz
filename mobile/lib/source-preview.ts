/** Owns the bounded native source preview transport and response contract. */

import { MobileApiError } from "./api"

/** One citation label shown in the source overview. */
export type MobileSourceCitation = {
  readonly label: string
  readonly detail?: string
}

/** Complete source data needed by the native overview and preview tabs. */
export type MobileSourceDetail = {
  readonly id: string
  readonly projectId: string
  readonly filename: string
  readonly status: "processing" | "ready" | "failed"
  readonly kind?: "pdf" | "markdown" | "text" | "paste"
  readonly error?: string
  readonly originalUrl?: string
  readonly relativeKey?: string
  readonly mimeType?: string
  readonly sizeBytes?: number
  readonly unsupported?: boolean
  readonly summary?: string
  readonly extractedText: string
  readonly createdAt?: number
  readonly citations: MobileSourceCitation[]
}

/** Returns true when an unknown value is a plain JSON object. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parses the bounded source detail response. */
function parse(value: unknown): MobileSourceDetail {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.projectId !== "string" ||
    typeof value.filename !== "string" ||
    typeof value.extractedText !== "string"
  )
    throw new MobileApiError("Server returned an invalid source preview")
  return {
    id: value.id,
    projectId: value.projectId,
    filename: value.filename,
    status:
      value.status === "ready" || value.status === "failed"
        ? value.status
        : "processing",
    ...(typeof value.kind === "string"
      ? { kind: value.kind as MobileSourceDetail["kind"] }
      : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.originalUrl === "string"
      ? { originalUrl: value.originalUrl }
      : {}),
    ...(typeof value.relativeKey === "string"
      ? { relativeKey: value.relativeKey }
      : {}),
    ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    ...(typeof value.sizeBytes === "number"
      ? { sizeBytes: value.sizeBytes }
      : {}),
    ...(value.unsupported === true ? { unsupported: true } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    extractedText: value.extractedText,
    ...(typeof value.createdAt === "number"
      ? { createdAt: value.createdAt }
      : {}),
    citations: Array.isArray(value.citations)
      ? value.citations.flatMap((citation) => {
          if (!record(citation) || typeof citation.label !== "string") return []
          return [
            {
              label: citation.label,
              ...(typeof citation.detail === "string"
                ? { detail: citation.detail }
                : {}),
            },
          ]
        })
      : [],
  }
}

/** Loads one source preview with caller cancellation and a bounded timeout. */
export async function fetchSourceDetail(
  baseUrl: string,
  projectId: string,
  sourceId: string,
  signal?: AbortSignal
): Promise<MobileSourceDetail> {
  const url = new URL(
    `${baseUrl.trim().replace(/\/+$/, "")}/api/mobile/sources/${encodeURIComponent(sourceId)}`
  )
  url.searchParams.set("projectId", projectId)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = await response.text()
    let value: unknown
    try {
      value = body ? (JSON.parse(body) as unknown) : undefined
    } catch {
      throw new MobileApiError("Source preview was unreadable")
    }
    if (!response.ok)
      throw new MobileApiError(
        record(value) && typeof value.error === "string"
          ? value.error
          : `Server request failed (${response.status})`
      )
    return parse(value)
  } catch (error) {
    if (signal?.aborted) throw error
    if (controller.signal.aborted)
      throw new MobileApiError("Source preview timed out. Try again.")
    if (error instanceof MobileApiError) throw error
    throw new MobileApiError("Could not load source preview")
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

/** Builds the existing safe original-file URL for opening or downloading. */
export function sourceFileUrl(
  baseUrl: string,
  projectId: string,
  sourceId: string,
  inline = true
): string {
  const url = new URL(`${baseUrl.trim().replace(/\/+$/, "")}/api/sources/file`)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("sourceId", sourceId)
  if (inline) url.searchParams.set("inline", "1")
  return url.toString()
}
