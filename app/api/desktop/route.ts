/**
 * Tells browser pages whether this Mac's Blitz desktop app opens `blitz://`
 * links, so a link that lands in a browser can reopen in the app
 * (`components/desktop-handoff.tsx`). Only a browser on this Mac is told yes;
 * other devices reach the same server but not this Mac's app.
 */

import {
  desktopAppOpensLinks,
  isThisMachine,
} from "@/lib/server/desktop-app"

/** The app can be installed or replaced at any time, so never cache the answer. */
export const dynamic = "force-dynamic"

/** Returns `{ opensLinks }` for the installed desktop app, false for other machines. */
export async function GET(request: Request): Promise<Response> {
  const opensLinks =
    isThisMachine(request.headers.get("x-forwarded-for")) &&
    (await desktopAppOpensLinks())
  return Response.json(
    { opensLinks },
    { headers: { "Cache-Control": "no-store" } }
  )
}
