/** Tests bounded source normalization, attribution, segmentation, and URL safety behavior. */

import assert from "node:assert/strict"
import test from "node:test"
import {
  SourceIngestionError,
  fetchPublicSource,
  isPublicIp,
  normalizeSourceDocument,
  segmentSourceDocument,
  validatePublicHttpUrl,
} from "../lib/server/source-ingestion/index.ts"

test("normalization preserves explicit page, slide, and timestamp labels", () => {
  const document = normalizeSourceDocument({
    filename: "lecture.md",
    kind: "transcript",
    text: "\uFEFF[Page 2]\r\nA page note.\r\n\r\n[Slide 4 — Acoustics]\r\nSlide note.\r\n[00:01:23] Speaker says this.",
  })
  assert.equal(
    document.text,
    "[Page 2]\nA page note.\n\n[Slide 4 — Acoustics]\nSlide note.\n[00:01:23] Speaker says this."
  )
  assert.deepEqual(
    document.markers.map((marker) => [marker.kind, marker.label]),
    [
      ["page", "[Page 2]"],
      ["slide", "[Slide 4 — Acoustics]"],
      ["time", "[00:01:23]"],
    ]
  )
  assert.equal(document.references[0]?.filename, "lecture.md")
  assert.equal(document.references[0]?.marker?.label, "[Page 2]")
  assert.equal(document.references[1]?.marker?.label, "[Slide 4 — Acoustics]")
})

test("normalization is deterministic and does not invent markers", () => {
  const input = {
    filename: "notes.txt",
    kind: "text" as const,
    text: "A 1:23 ratio\nNo source marker.",
  }
  const first = normalizeSourceDocument(input)
  const second = normalizeSourceDocument(input)
  assert.equal(first.sourceId, second.sourceId)
  assert.deepEqual(first.markers, [])
  assert.deepEqual(first.references, [
    { filename: "notes.txt", startOffset: 0, endOffset: first.text.length },
  ])
})

test("normalization keeps a filename reference before the first explicit marker", () => {
  const document = normalizeSourceDocument({
    filename: "handout.txt",
    kind: "text",
    text: "Preface\n[Page 3]\nPage content",
  })
  assert.equal(document.references[0]?.filename, "handout.txt")
  assert.equal(document.references[0]?.marker, undefined)
  assert.equal(
    document.references[0]?.endOffset,
    document.markers[0]?.startOffset
  )
  assert.equal(document.references[1]?.marker?.label, "[Page 3]")
})

test("segmentation covers all source text and retains bounded overlap", () => {
  const document = normalizeSourceDocument({
    sourceId: "source-fixed",
    filename: "long.md",
    kind: "markdown",
    text: Array.from(
      { length: 24 },
      (_, index) => `Paragraph ${index}: ${"concept ".repeat(12)}`
    ).join("\n\n"),
  })
  const chunks = segmentSourceDocument(document, {
    chunkSize: 256,
    overlap: 30,
  })
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.text.length <= 256))
  assert.deepEqual(
    chunks,
    segmentSourceDocument(document, { chunkSize: 256, overlap: 30 })
  )
  let reconstructed = chunks[0]?.text ?? ""
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1]!
    const current = chunks[index]!
    const overlap = previous.endOffset - current.startOffset
    reconstructed += current.text.slice(overlap)
  }
  assert.equal(reconstructed, document.text)
  assert.equal(chunks[0]?.references[0]?.marker, undefined)
})

test("segmentation keeps Unicode code points intact at hard boundaries", () => {
  const document = normalizeSourceDocument({
    sourceId: "unicode-source",
    kind: "text",
    text: "🙂".repeat(220),
  })
  const chunks = segmentSourceDocument(document, {
    chunkSize: 256,
    overlap: 16,
  })
  assert.ok(
    chunks.every(
      (chunk) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk.text)
    )
  )
  let reconstructed = chunks[0]?.text ?? ""
  for (let index = 1; index < chunks.length; index += 1) {
    const overlap = chunks[index - 1]!.endOffset - chunks[index]!.startOffset
    reconstructed += chunks[index]!.text.slice(overlap)
  }
  assert.equal(reconstructed, document.text)
})

test("segmentation reports the source and limit when chunk count is bounded", () => {
  const document = normalizeSourceDocument({
    kind: "text",
    text: "x".repeat(2_000),
  })
  assert.throws(
    () =>
      segmentSourceDocument(document, {
        chunkSize: 256,
        overlap: 0,
        maxChunks: 2,
      }),
    (error: unknown) => {
      assert.ok(error instanceof SourceIngestionError)
      assert.equal(error.code, "chunk-limit-exceeded")
      assert.equal(error.context.sourceId, document.sourceId)
      return true
    }
  )
})

test("public URL validation rejects credentials, local hosts, and private answers", async () => {
  await assert.rejects(() => validatePublicHttpUrl("file:///etc/passwd"), {
    code: "invalid-url",
  })
  await assert.rejects(
    () => validatePublicHttpUrl("https://user:pass@example.com/"),
    { code: "invalid-url" }
  )
  await assert.rejects(() => validatePublicHttpUrl("http://localhost/"), {
    code: "private-url",
  })
  await assert.rejects(
    () =>
      validatePublicHttpUrl("https://example.com/", async () => ["127.0.0.1"]),
    { code: "private-url" }
  )
  assert.equal(isPublicIp("93.184.216.34"), true)
  assert.equal(isPublicIp("192.168.1.4"), false)
  assert.equal(isPublicIp("::1"), false)
  assert.equal(isPublicIp("::ffff:93.184.216.34"), true)
})

test("public URL validation bounds a slow DNS resolver", async () => {
  await assert.rejects(
    () =>
      fetchPublicSource("https://slow.test/source", {
        timeoutMs: 10,
        resolve: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40))
          return ["93.184.216.34"]
        },
      }),
    { code: "url-timeout" }
  )
})

test("public fetch validates redirects and enforces response byte caps", async () => {
  let calls = 0
  let redirectBodyCancelled = false
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1
    const url = String(input)
    if (url.endsWith("/start"))
      return new Response(
        new ReadableStream({
          cancel() {
            redirectBodyCancelled = true
          },
        }),
        {
          status: 302,
          headers: { location: "http://private.test/next" },
        }
      )
    return new Response("too late")
  }
  await assert.rejects(
    () =>
      fetchPublicSource("https://public.test/start", {
        resolve: async (hostname) =>
          hostname === "public.test" ? ["93.184.216.34"] : ["10.0.0.2"],
        fetchImpl,
      }),
    { code: "private-url" }
  )
  assert.equal(calls, 1)
  assert.equal(redirectBodyCancelled, true)

  const oversized: typeof fetch = async () =>
    new Response("12345", { headers: { "content-length": "5" } })
  await assert.rejects(
    () =>
      fetchPublicSource("https://public.test/file", {
        maxBytes: 4,
        resolve: async () => ["93.184.216.34"],
        fetchImpl: oversized,
      }),
    { code: "url-too-large" }
  )

  const streamedOversized: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345"))
          controller.close()
        },
      })
    )
  await assert.rejects(
    () =>
      fetchPublicSource("https://public.test/stream", {
        maxBytes: 4,
        resolve: async () => ["93.184.216.34"],
        fetchImpl: streamedOversized,
      }),
    { code: "url-too-large" }
  )
})
