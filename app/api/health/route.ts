/**
 * Answers the local supervisor's liveness probe without rendering a page.
 *
 * The updater also reads `activeChatRuns` and holds a server restart until no
 * chat reply is streaming (see `electron/auto-update.mjs`).
 */

import { activeChatRunCount } from "@/lib/server/chat-run-registry"

/** Never cache the probe; a stale success would hide a stuck server. */
export const dynamic = "force-dynamic"

/** Returns a tiny success response with the number of chat replies in progress. */
export function GET(): Response {
  return Response.json(
    { ok: true, activeChatRuns: activeChatRunCount() },
    { headers: { "Cache-Control": "no-store" } }
  )
}
