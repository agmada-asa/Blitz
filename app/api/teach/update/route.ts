/**
 * Starts a lesson update for a unit whose files have changed since its outline
 * was planned. The Teach screen, the module page and the MCP server all come
 * through here. The update runs in the background; its state is saved on the
 * Teach session, so callers follow it there rather than holding a request open.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { serverConvexClient } from "@/lib/server/convex"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import { runTeachUpdate } from "@/lib/server/teach-update"

/** Uses Node.js because the analysis starts a local provider process. */
export const runtime = "nodejs"

/**
 * Claims the unit's lesson and starts the analysis.
 *
 * @returns `{ status }`: `started`, or `no-lesson`, `up-to-date`, `running`,
 *   `busy` when nothing was started. 400 for a bad unit id, 403 for an
 *   untrusted origin, 500 when the claim itself failed.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json({ error: "Open Blitz to update a lesson" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as { unitId?: unknown } | null
  const unitId = body?.unitId
  if (typeof unitId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(unitId))
    return Response.json({ error: "A unit is required" }, { status: 400 })
  try {
    const client = serverConvexClient(() => new Error("Blitz data is unavailable"))
    const claim = await client.mutation(api.teachUpdates.begin, {
      unitId: unitId as Id<"units">,
    })
    if (claim.status === "started") void runTeachUpdate(claim.chatId, claim.token)
    return Response.json({ status: claim.status })
  } catch (error) {
    console.error("A lesson update could not start", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return Response.json({ error: "The update could not start. Try again." }, { status: 500 })
  }
}
