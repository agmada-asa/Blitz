/** Exposes the bounded Convex activity query to the native Blitz client. */

import { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"

/** Uses Node.js because the route creates a server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Creates the configured Convex client or fails without exposing configuration. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new Error("Convex is not configured")
  return new ConvexHttpClient(endpoint)
}

/** Returns current work and at most the same notification rows as the web app. */
export async function GET() {
  try {
    return Response.json(await convexClient().query(api.activity.list, {}), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch {
    return Response.json(
      { error: "Activity service is unavailable" },
      { status: 503 }
    )
  }
}
