/**
 * Tells browser pages whether this Mac's Blitz desktop app opens `blitz://`
 * links, so a link that lands in a browser can reopen in the app
 * (`components/desktop-handoff.tsx`).
 */

import { desktopAppOpensLinks } from "@/lib/server/desktop-app"

/** The app can be installed or replaced at any time, so never cache the answer. */
export const dynamic = "force-dynamic"

/** Returns `{ opensLinks }` for the installed desktop app. */
export async function GET(): Promise<Response> {
  return Response.json(
    { opensLinks: await desktopAppOpensLinks() },
    { headers: { "Cache-Control": "no-store" } }
  )
}
