/** Reports local provider setup so pickers and save preflight can reject unavailable runtimes. */

import { PROVIDER_DEFINITIONS } from "@/lib/server/providers/registry"

/** Runs executable checks on the local Node.js host. */
export const runtime = "nodejs"

/** Checks configured providers without sending prompts or starting model sessions. */
export async function GET() {
  const providers = await Promise.all(
    PROVIDER_DEFINITIONS.map((provider) =>
      provider.checkAvailability({ workspaceDirectory: process.cwd() })
    )
  )
  return Response.json(providers, { headers: { "Cache-Control": "no-store" } })
}
