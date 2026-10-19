/** Tests approved source import lifecycle without network access or Convex. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyResearchImportFailure,
  runResearchImportStep,
  type ResearchImportQueue,
} from "../lib/server/research-import-worker.ts"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"
import {
  buildResearchImportCheckpoint,
  researchImportPartMatchesSource,
  validateResearchImportPartSequence,
} from "../lib/research-import-checkpoint.ts"

/** Verifies the durable multipart transition keeps the lease until the final part. */
test("multipart checkpoint retains lease before final part and clears it at completion", () => {
  const first = buildResearchImportCheckpoint({
    existingSourceIds: [],
    existingPreparationJobIds: [],
    sourceId: "source-1",
    preparationJobId: "job-1",
    totalParts: 2,
  })
  assert.deepEqual(first, {
    status: "running",
    sourceIds: ["source-1"],
    preparationJobIds: ["job-1"],
    clearLease: false,
  })
  const second = buildResearchImportCheckpoint({
    existingSourceIds: first.sourceIds,
    existingPreparationJobIds: first.preparationJobIds,
    sourceId: "source-2",
    preparationJobId: "job-2",
    totalParts: 2,
  })
  assert.equal(second.status, "imported")
  assert.equal(second.clearLease, true)
})

/** Verifies retries remain idempotent while changed fetched content is rejected. */
test("multipart replay matches all immutable source fields", () => {
  const source = {
    filename: "guide.txt",
    kind: "text" as const,
    extractedText: "stable body",
    originalUrl: "https://example.com/guide.txt",
  }
  assert.equal(
    researchImportPartMatchesSource({
      existingSource: source,
      ...source,
    }),
    true
  )
  assert.equal(
    researchImportPartMatchesSource({
      existingSource: source,
      ...source,
      extractedText: "changed body",
    }),
    false
  )
})

/** Verifies gaps and mismatched checkpoint counts fail before a database write. */
test("multipart checkpoint rejects gaps and mismatched arrays", () => {
  assert.throws(() =>
    validateResearchImportPartSequence({
      existingPartCount: 0,
      partNumber: 2,
      totalParts: 2,
    })
  )
  assert.throws(() =>
    buildResearchImportCheckpoint({
      existingSourceIds: ["source-1"],
      existingPreparationJobIds: [],
      sourceId: "source-2",
      preparationJobId: "job-2",
      totalParts: 2,
    })
  )
})

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
  // Passages travel with the source, split the same way uploads are.
  const payload = completed[0] as {
    extractedText: string
    chunks: Array<{
      text: string
      startOffset: number
      endOffset: number
      references: Array<{ kind?: string; value: string }>
    }>
  }
  assert.equal(payload.chunks.length, 1)
  assert.equal(
    payload.extractedText.slice(
      payload.chunks[0].startOffset,
      payload.chunks[0].endOffset
    ),
    payload.chunks[0].text
  )
  assert.deepEqual(
    payload.chunks[0].references.map((reference) => [
      reference.kind,
      reference.value,
    ]),
    [["page", "1"]]
  )
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

/** Splits a large approved source into durable bounded completion checkpoints. */
test("research import worker completes oversized sources as attributed parts", async () => {
  const completed: Array<Record<string, unknown>> = []
  const queue: ResearchImportQueue = {
    claimNextImport: async () => ({
      importId: "import-large",
      projectId: "project-1",
      sourceIndex: 0,
      source: {
        url: "https://example.com/manual.html",
        title: "Manual",
        reason: "Covers the requested topic.",
        verification: "suggested-unverified",
      },
      leaseToken: "lease-large",
    }),
    completeImport: async (value) => {
      completed.push(value as unknown as Record<string, unknown>)
      return {
        sourceId: `source-${value.partNumber}`,
        preparationJobId: `job-${value.partNumber}`,
      }
    },
    failImport: async () => undefined,
  }
  const result = await runResearchImportStep({
    queue,
    workerId: "worker-1",
    fetchSource: async () => ({
      filename: "manual.html",
      kind: "markdown",
      extractedText: `${"A".repeat(119_000)}\n${"B".repeat(119_000)}`,
      originalUrl: "https://example.com/manual.html",
    }),
  })
  assert.equal(result.status, "imported")
  assert.equal(completed.length, 2)
  assert.deepEqual(
    completed.map((part) => [part.partNumber, part.totalParts]),
    [
      [1, 2],
      [2, 2],
    ]
  )
  assert.match(String(completed[0]?.filename), /Part 1 of 2/)
})
