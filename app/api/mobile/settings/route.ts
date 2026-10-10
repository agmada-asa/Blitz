/** Exposes the validated global AI settings to the native Blitz client. */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"

import { api } from "@/convex/_generated/api"
import {
  validateAiModelSettings,
  validateAiTaskProviders,
} from "@/lib/ai-model-settings"

/** Uses Node.js because the route creates a server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Creates the configured Convex client or fails without exposing configuration. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(() => new Error("Convex is not configured"))
}

/** Reads the persisted AI settings without returning provider credentials. */
export async function GET() {
  try {
    return Response.json(await convexClient().query(api.settings.get, {}), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch {
    return Response.json(
      { error: "Settings service is unavailable" },
      { status: 503 }
    )
  }
}

/** Validates and saves one complete settings object as an atomic Convex mutation. */
export async function PUT(request: Request) {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid settings" }, { status: 400 })
    }
    const input = body as Record<string, unknown>
    const required = [
      "researchModel",
      "replyModel",
      "cardGenerationModel",
      "researchEffort",
      "replyEffort",
      "cardGenerationEffort",
    ]
    if (
      required.some(
        (field) =>
          typeof input[field] !== "string" ||
          input[field].trim().length === 0 ||
          input[field].length > 120
      )
    ) {
      return Response.json({ error: "Invalid settings" }, { status: 400 })
    }
    const settings = validateAiModelSettings({
      providerApprovalPolicies: input.providerApprovalPolicies as
        Record<string, string> | undefined,
      researchProvider: input.researchProvider as string | undefined,
      replyProvider: input.replyProvider as string | undefined,
      cardGenerationProvider: input.cardGenerationProvider as
        string | undefined,
      researchModel: input.researchModel as string,
      replyModel: input.replyModel as string,
      cardGenerationModel: input.cardGenerationModel as string,
      researchEffort: input.researchEffort as string,
      replyEffort: input.replyEffort as string,
      cardGenerationEffort: input.cardGenerationEffort as string,
    })
    validateAiTaskProviders(settings)
    return Response.json(
      await convexClient().mutation(api.settings.save, settings)
    )
  } catch {
    return Response.json(
      { error: "Settings could not be saved" },
      { status: 400 }
    )
  }
}
