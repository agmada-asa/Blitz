/** Serves a Teach or drill session summary to the Android app. */

import {
  MobileRequestError,
  mobileErrorResponse,
  readId,
  readTimezoneOffset,
  sessionSummary,
} from "@/lib/server/mobile-learning"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns the summary for `?projectId=&since=&tz=`, optionally one `&unitId=`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams
    const since = Number(params.get("since"))
    if (!Number.isFinite(since) || since < 0) throw new MobileRequestError("Session start is invalid")
    const unit = params.get("unitId")
    return Response.json(
      await sessionSummary({
        projectId: readId(params.get("projectId"), "Module"),
        ...(unit ? { unitId: readId(unit, "Unit") } : {}),
        since,
        tzOffsetMinutes: readTimezoneOffset(params.get("tz")),
      }),
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return mobileErrorResponse(error, "summary")
  }
}
