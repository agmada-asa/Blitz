/**
 * Drains approved source-index imports with bounded public fetches and atomic
 * persistence. Each part is split into passages here, the same way uploads
 * are, and saved with its source so Teach can cite it immediately.
 */

import { randomUUID } from "node:crypto"
import {
  fetchApprovedResearchSource,
  type ResearchImportedSource,
} from "./research-import.ts"
import {
  prepareTextSource,
  type PersistedChunkRow,
} from "./source-ingestion/chunk-rows.ts"
import { SourceIngestionError } from "./source-ingestion/errors.ts"
import { splitSourceText, sourcePartFilename } from "../source-splitting.ts"

/** Stable source-import categories suitable for retry and recovery copy. */
export type ResearchImportFailureCategory =
  | "site-refused"
  | "not-found"
  | "unsupported-format"
  | "needs-ocr"
  | "too-large"
  | "timeout"
  | "invalid-url"
  | "download-failed"

/** Maps bounded ingestion errors and HTTP statuses to safe fixed categories. */
export function classifyResearchImportFailure(
  error: unknown
): ResearchImportFailureCategory {
  if (!(error instanceof SourceIngestionError)) return "download-failed"
  if (error.context.reason === "redirected-to-homepage") return "not-found"
  if (error.code === "url-fetch-failed") {
    const status = error.context.status
    if (status === 401 || status === 403) return "site-refused"
    if (status === 404 || status === 410) return "not-found"
    if (status === 408 || status === 429 || status === 504) return "timeout"
    return "download-failed"
  }
  if (error.code === "url-timeout") return "timeout"
  if (error.code === "url-too-large" || error.code === "input-too-large")
    return "too-large"
  if (error.code === "private-url" || error.code === "invalid-url")
    return "invalid-url"
  if (
    error.code === "url-redirect-limit" ||
    error.code === "url-resolution-failed"
  )
    return "download-failed"
  if (
    error.context.format === "pdf" &&
    /no extractable text/i.test(error.message)
  )
    return "needs-ocr"
  if (error.code === "invalid-input") return "unsupported-format"
  return "download-failed"
}

/** A selected source import claimed by the local worker. */
export interface ResearchImportClaim {
  /** Persisted import record identifier. */
  importId: string
  /** Project receiving the source. */
  projectId: string
  /** Source index in the immutable ready proposal. */
  sourceIndex: number
  /** URL loaded from the ready proposal, never from a client apply body. */
  source: {
    url: string
    title: string
    reason: string
    verification: "suggested-unverified"
  }
  /** Capability token for the current lease. */
  leaseToken: string
}

/** Persistence calls required by one selected-source import step. */
export interface ResearchImportQueue {
  /** Claims one queued or expired import, or returns null. */
  claimNextImport(args: {
    workerId: string
    leaseToken: string
  }): Promise<ResearchImportClaim | null>
  /** Atomically creates the source and preparation job for a live import. */
  completeImport(args: {
    importId: string
    leaseToken: string
    filename: string
    kind: "pdf" | "markdown" | "text"
    extractedText: string
    originalUrl: string
    partNumber?: number
    totalParts?: number
    /** Passages of `extractedText`, saved with the source. */
    chunks?: PersistedChunkRow[]
  }): Promise<unknown>
  /** Records a classified per-source error while preserving deliberate retry. */
  failImport(args: {
    importId: string
    leaseToken: string
    failureCategory: ResearchImportFailureCategory
  }): Promise<unknown>
}

/** Options for one selected-source import step. */
export interface ResearchImportWorkerOptions {
  workerId: string
  signal?: AbortSignal
  queue: ResearchImportQueue
  /** Injectable bounded fetch/extract function for tests. */
  fetchSource?: (url: string) => Promise<ResearchImportedSource>
}

/** Result returned after one import queue poll. */
export type ResearchImportStepResult =
  | { status: "idle" }
  | {
      status: "imported"
      importId: string
      sourceId?: string
      preparationJobId?: string
    }
  | {
      status: "failed"
      importId: string
      failureCategory: ResearchImportFailureCategory
    }

/** Fetches, extracts, and atomically persists one approved source import. */
export async function runResearchImportStep(
  options: ResearchImportWorkerOptions
): Promise<ResearchImportStepResult> {
  if (!options.workerId.trim())
    throw new Error("Research worker id is required")
  options.signal?.throwIfAborted()
  const claim = await options.queue.claimNextImport({
    workerId: options.workerId,
    leaseToken: randomUUID(),
  })
  if (!claim) return { status: "idle" }
  try {
    options.signal?.throwIfAborted()
    const source = await (options.fetchSource ?? fetchApprovedResearchSource)(
      claim.source.url
    )
    options.signal?.throwIfAborted()
    const parts = splitSourceText(source.extractedText)
    let persisted: {
      sourceId?: string
      preparationJobId?: string
      sourceIds?: string[]
      preparationJobIds?: string[]
    } = {}
    for (const part of parts) {
      options.signal?.throwIfAborted()
      const filename = sourcePartFilename(
        claim.source.title,
        part.partNumber,
        part.totalParts
      )
      // The stored text is the normalized part, so passage offsets match it.
      const prepared = prepareTextSource({
        seed: `research:${claim.importId}:${part.partNumber}`,
        filename,
        kind: source.kind,
        text: part.text,
      })
      const result = await options.queue.completeImport({
        importId: claim.importId,
        leaseToken: claim.leaseToken,
        filename,
        kind: source.kind,
        extractedText: prepared.text,
        chunks: prepared.chunks,
        originalUrl: source.originalUrl,
        partNumber: part.partNumber,
        totalParts: part.totalParts,
      })
      const current = result as typeof persisted
      persisted = {
        ...persisted,
        ...current,
        sourceIds: [
          ...(persisted.sourceIds ?? []),
          ...(current.sourceId ? [current.sourceId] : []),
        ],
        preparationJobIds: [
          ...(persisted.preparationJobIds ?? []),
          ...(current.preparationJobId ? [current.preparationJobId] : []),
        ],
      }
    }
    return {
      status: "imported",
      importId: claim.importId,
      ...(persisted.sourceId === undefined
        ? {}
        : { sourceId: persisted.sourceId }),
      ...(persisted.preparationJobId === undefined
        ? {}
        : { preparationJobId: persisted.preparationJobId }),
      ...(parts.length > 1 && persisted.sourceIds !== undefined
        ? { sourceIds: persisted.sourceIds }
        : {}),
      ...(parts.length > 1 && persisted.preparationJobIds !== undefined
        ? { preparationJobIds: persisted.preparationJobIds }
        : {}),
    }
  } catch (error) {
    const failureCategory = classifyResearchImportFailure(error)
    await options.queue
      .failImport({
        importId: claim.importId,
        leaseToken: claim.leaseToken,
        failureCategory,
      })
      .catch(() => undefined)
    if (options.signal?.aborted)
      throw new Error("Research source import was interrupted")
    return { status: "failed", importId: claim.importId, failureCategory }
  }
}
