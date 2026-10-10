/** Serves the Android app's module library with each module's progress. */

import { libraryModules, mobileErrorResponse } from "@/lib/server/mobile-learning"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns every module, most recently studied first. */
export async function GET(): Promise<Response> {
  try {
    return Response.json(await libraryModules(), { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return mobileErrorResponse(error, "library")
  }
}
