/** Accepts bounded source text and returns one schema-validated generated study set. */

import { generateStudySet } from "@/lib/server/codex"
import {
  MAX_FILENAME_LENGTH,
  MAX_SOURCE_TEXT_LENGTH,
} from "@/lib/server/generate-schema"

/** Uses Node.js because generation launches the local Codex process. */
export const runtime = "nodejs"

/** Handles generation requests and maps invalid input or generator failures to JSON errors. */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    )
  }
  try {
    if (!body || typeof body !== "object")
      return Response.json({ error: "Invalid request" }, { status: 400 })
    const filename =
      "filename" in body && typeof body.filename === "string"
        ? body.filename.trim()
        : ""
    const text =
      "text" in body && typeof body.text === "string" ? body.text.trim() : ""
    if (
      !filename ||
      filename.length > MAX_FILENAME_LENGTH ||
      !text ||
      text.length > MAX_SOURCE_TEXT_LENGTH
    ) {
      return Response.json(
        {
          error:
            "Filename and source text are required within the allowed limits",
        },
        { status: 400 }
      )
    }
    return Response.json(await generateStudySet(filename, text))
  } catch {
    return Response.json(
      { error: "Unable to generate study cards right now" },
      { status: 502 }
    )
  }
}
