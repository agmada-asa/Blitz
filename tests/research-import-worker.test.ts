/** Tests approved source import lifecycle without network access or Convex. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyResearchImportFailure,
  runResearchImportStep,
  type ResearchImportQueue,
} from "../lib/server/research-import-worker.ts"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"

/** Maps known source failures to actionable categories without retaining details. */
test("classifies refused, missing, oversized, OCR, and timeout failures", () => {
  assert.equal(
    classifyResearchImportFailure(
      new SourceIngestionError("url-fetch-failed", "ignored", { status: 403 })
    ),
    "site-refused"
  )
  assert.equal(
    classifyResearchImportFailure(
      new SourceIngestionError("url-fetch-failed", "ignored", { status: 404 })
    ),
    "not-found"
  )
  assert.equal(
    classifyResearchImportFailure(
      new SourceIngestionError("url-too-large", "ignored")
    ),
    "too-large"
  )
  assert.equal(
    classifyResearchImportFailure(
      new SourceIngestionError("invalid-input", "no extractable text", {
        format: "pdf",
      })
    ),
    "needs-ocr"
  )
  assert.equal(
    classifyResearchImportFailure(
      new SourceIngestionError("url-timeout", "ignored")
    ),
    "timeout"
  )
})

/** Claims one source and records the atomic completion payload. */
test("research import worker completes a bounded PDF source", async () => {
  const completed: unknown[] = []
  const queue: ResearchImportQueue = {
    claimNextImport: async () => ({
      importId: "import-1",
      projectId: "project-1",
      sourceIndex: 0,
      source: {
        url: "https://example.com/guide.pdf",
        title: "Guide",
        reason: "Covers the requested topic.",
        verification: "suggested-unverified",
      },
      leaseToken: "lease-1",
    }),
    completeImport: async (value) => {
      completed.push(value)
      return { sourceId: "source-1", preparationJobId: "job-1" }
    },
    failImport: async () => undefined,
  }
  const result = await runResearchImportStep({
    queue,
    workerId: "worker-1",
    fetchSource: async () => ({
      filename: "guide.pdf",
      kind: "pdf",
      extractedText: "[Page 1]\nReadable guide text.",
      originalUrl: "https://example.com/guide.pdf",
    }),
  })
  assert.deepEqual(result, {
    status: "imported",
    importId: "import-1",
    sourceId: "source-1",
    preparationJobId: "job-1",
  })
  assert.equal(completed.length, 1)
})

/** Records a safe failure and never exposes an injected fetch error. */
test("research import worker turns fetch failures into deliberate retries", async () => {
  const failures: Array<{ failureCategory: string }> = []
  const queue: ResearchImportQueue = {
    claimNextImport: async () => ({
      importId: "import-2",
      projectId: "project-1",
      sourceIndex: 0,
      source: {
        url: "https://example.com/guide.txt",
        title: "Guide",
        reason: "Covers the requested topic.",
        verification: "suggested-unverified",
      },
      leaseToken: "lease-2",
    }),
    completeImport: async () => undefined,
    failImport: async (value) => {
      failures.push({ failureCategory: value.failureCategory })
    },
  }
  const result = await runResearchImportStep({
    queue,
    workerId: "worker-1",
    fetchSource: async () => {
      throw new Error("private response body should not be persisted")
    },
  })
  assert.deepEqual(result, {
    status: "failed",
    importId: "import-2",
    failureCategory: "download-failed",
  })
  assert.deepEqual(failures, [{ failureCategory: "download-failed" }])
})
