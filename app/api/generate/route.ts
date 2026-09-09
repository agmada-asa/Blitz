/** Accepts bounded source text and returns one schema-validated generated study set. */

import { generateStudySetWithProvider } from "@/lib/server/provider-generation"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import { resolveAiTaskSelection } from "@/lib/ai-model-settings"
import {
  MAX_FILENAME_LENGTH,
  MAX_SOURCE_TEXT_LENGTH,
} from "@/lib/server/generate-schema"
import { ConvexHttpClient } from "convex/browser"

/** Uses Node.js because generation launches the selected local provider process. */
export const runtime = "nodejs"

/** Opens the local Convex deployment when model settings are available to this route. */
function settingsClient(): ConvexHttpClient | null {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) return null
  try {
    return new ConvexHttpClient(endpoint)
  } catch {
    return null
  }
}

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
    const settings = await loadSavedAiModelSettings(settingsClient())
    const selection = resolveAiTaskSelection(settings, "cardGeneration", {
      providerEnvironmentFallback: process.env.BLITZ_CARD_GENERATION_PROVIDER,
      modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
      effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
    })
    return Response.json(
      await generateStudySetWithProvider(filename, text, selection)
    )
  } catch {
    return Response.json(
      { error: "Unable to generate study cards right now" },
      { status: 502 }
    )
  }
}
