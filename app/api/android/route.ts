/** Streams the configured local Android preview artifact for installation over the LAN. */

import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { Readable } from "node:stream"

/** Local artifact access requires the Node.js filesystem runtime. */
export const runtime = "nodejs"

/** Serves only the operator-configured APK, or a quiet 404 when it is unavailable. */
export async function GET(): Promise<Response> {
  const artifactPath = process.env.BLITZ_ANDROID_APK_PATH
  if (
    !artifactPath ||
    !isAbsolute(artifactPath) ||
    !artifactPath.endsWith(".apk")
  )
    return new Response("Android preview is not available", { status: 404 })
  try {
    const artifact = await stat(artifactPath)
    if (!artifact.isFile()) throw new Error("Artifact is not a file")
    const stream = Readable.toWeb(createReadStream(artifactPath))
    return new Response(stream as ReadableStream<Uint8Array>, {
      headers: {
        "Content-Type": "application/vnd.android.package-archive",
        "Content-Disposition": 'attachment; filename="blitz-android-debug.apk"',
        "Content-Length": String(artifact.size),
        "Cache-Control": "no-store",
      },
    })
  } catch {
    return new Response("Android preview is not available", { status: 404 })
  }
}
