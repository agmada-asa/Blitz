/** Answers the local supervisor's liveness probe without rendering a page. */

/** Never cache the probe; a stale success would hide a stuck server. */
export const dynamic = "force-dynamic"

/** Returns a tiny success response while the Next server can handle requests. */
export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
}
