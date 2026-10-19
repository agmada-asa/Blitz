/** Serves the Android app's Today page: XP, streak, week, and the unit to resume. */

import { homeSummary, mobileErrorResponse, readTimezoneOffset } from "@/lib/server/mobile-learning"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns today's progress; `?tz=` is the device's `getTimezoneOffset()`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const tz = readTimezoneOffset(new URL(request.url).searchParams.get("tz"))
    return Response.json(await homeSummary(tz), { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return mobileErrorResponse(error, "progress")
  }
}
