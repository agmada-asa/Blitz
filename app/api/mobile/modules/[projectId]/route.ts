/** Serves one module's learning path, practice summary, and exam papers to the Android app. */

import { mobileErrorResponse, moduleDetail, readId } from "@/lib/server/mobile-learning"

/** Uses Node.js for the server-side Convex HTTP client. */
export const runtime = "nodejs"

/** Returns the module named in the path. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  try {
    const { projectId } = await params
    return Response.json(await moduleDetail(readId(projectId, "Module")), {
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    return mobileErrorResponse(error, "module")
  }
}
