/** Creates the server-side Convex client used by route handlers and workers. */

import { ConvexHttpClient } from "convex/browser"

/**
 * Returns a Convex client for this machine's deployment.
 *
 * Prefers `BLITZ_CONVEX_URL`, the loopback address the launcher sets for
 * server code, then the public URLs used by older configurations.
 *
 * @throws When no Convex URL is configured.
 */
export function serverConvexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new Error("Blitz's database is not configured")
  return new ConvexHttpClient(endpoint)
}
