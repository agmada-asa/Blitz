/**
 * Serves a unit's Teach session to the Android app and opens it.
 *
 * GET returns the session (unit, outline, progress, messages, answered
 * quizzes); the app polls it while a reply is being written. POST opens the
 * session, creating it on first visit, or restarts it. Turns themselves are
 * sent to the shared `/api/chat` route and quiz answers to `/api/teach/answer`,
 * exactly as on desktop.
 */

import {
  MobileRequestError,
  mobileErrorResponse,
  readId,
  startTeachSession,
  teachSession,
} from "@/lib/server/mobile-learning"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns the session for `?unitId=`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const unitId = readId(new URL(request.url).searchParams.get("unitId"), "Unit")
    return Response.json(await teachSession(unitId), { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return mobileErrorResponse(error, "unit")
  }
}

/** Opens or restarts the session for `{ unitId, restart? }` and returns its chat id. */
export async function POST(request: Request): Promise<Response> {
  try {
    if (!isTrustedBlitzOrigin(request)) throw new MobileRequestError("Open Blitz to start a lesson", 403)
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) throw new MobileRequestError("Lesson request is invalid")
    const unitId = readId(body.unitId, "Unit")
    return Response.json(await startTeachSession(unitId, body.restart === true))
  } catch (error) {
    return mobileErrorResponse(error, "unit")
  }
}
