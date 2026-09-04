/** Fetches a validated public source for browser-side text or PDF extraction. */

import {
  fetchPublicSource,
  SourceIngestionError,
} from "@/lib/server/source-ingestion"

/** Uses Node.js because public source fetching pins DNS through Node's HTTP clients. */
export const runtime = "nodejs"

/** Returns a safe status for a bounded source-ingestion failure. */
function statusForError(error: SourceIngestionError): number {
  if (error.code === "url-timeout") return 408
  if (error.code === "url-too-large") return 413
  if (
    error.code === "invalid-url" ||
    error.code === "private-url" ||
    error.code === "url-resolution-failed"
  )
    return 400
  return 502
}

/** Handles one URL import request without forwarding browser cookies or local data. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    )
  }
  const url =
    body &&
    typeof body === "object" &&
    "url" in body &&
    typeof body.url === "string"
      ? body.url.trim()
      : ""
  if (!url || url.length > 2_048) {
    return Response.json(
      { error: "Enter a valid public source URL" },
      { status: 400 }
    )
  }

  try {
    const source = await fetchPublicSource(url, {
      maxBytes: 5_000_000,
      timeoutMs: 15_000,
      maxRedirects: 3,
    })
    const contentType = source.contentType?.split(";", 1)[0].toLowerCase() ?? ""
    const isPdf =
      contentType === "application/pdf" ||
      (!contentType && /\.pdf$/i.test(new URL(source.url).pathname))
    const isPowerPoint =
      contentType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      /\.pptx$/i.test(new URL(source.url).pathname)
    const isText = [
      "text/plain",
      "text/markdown",
      "text/html",
      "text/x-markdown",
    ].includes(contentType)
    if (!isPdf && !isPowerPoint && !isText) {
      return Response.json(
        {
          error:
            "This link must return PDF, HTML, Markdown, plain text, or PowerPoint.",
        },
        { status: 415 }
      )
    }
    const body = new Uint8Array(source.bytes.byteLength)
    body.set(source.bytes)
    return new Response(new Blob([body.buffer]), {
      headers: {
        "Content-Type": isPdf
          ? "application/pdf"
          : isPowerPoint
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : `${contentType}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Source-URL": source.url,
      },
    })
  } catch (error) {
    if (error instanceof SourceIngestionError) {
      return Response.json(
        { error: error.message },
        { status: statusForError(error) }
      )
    }
    return Response.json(
      { error: "That source could not be fetched." },
      { status: 502 }
    )
  }
}
