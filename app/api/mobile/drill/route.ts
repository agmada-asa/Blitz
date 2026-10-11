/** Serves an adaptive drill to the Android app as question cards without answer keys. */

import { drillQuestions, mobileErrorResponse, readId } from "@/lib/server/mobile-learning"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Questions in a drill unless `?limit=` asks for another number. */
const DEFAULT_DRILL_LENGTH = 10

/** Returns a drill for `?projectId=`, optionally one `&unitId=`. */
export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams
    const projectId = readId(params.get("projectId"), "Module")
    const unit = params.get("unitId")
    const limit = Math.max(1, Math.min(20, Number(params.get("limit")) || DEFAULT_DRILL_LENGTH))
    return Response.json(
      await drillQuestions(projectId, unit ? readId(unit, "Unit") : undefined, limit),
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return mobileErrorResponse(error, "drill")
  }
}
