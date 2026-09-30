/** Exposes bounded, same-origin text-to-speech through the local Kokoro runtime. */

import { isKokoroVoiceId } from "@/lib/kokoro-voices"
import { SPEECH_OPENING_CHARS } from "@/lib/speech-text"
import {
  KOKORO_MAX_TEXT_LENGTH,
  KokoroUnavailableError,
  synthesizeKokoroWav,
} from "@/lib/server/kokoro"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Runs local model inference in the Node.js process environment. */
export const runtime = "nodejs"

/** Reads a request body with a byte limit before decoding or parsing the JSON. */
async function readBoundedBody(request: Request): Promise<unknown> {
  const maxBytes = KOKORO_MAX_TEXT_LENGTH * 4 + 1_024
  const declaredLength = Number(request.headers.get("content-length") ?? 0)
  if (declaredLength > maxBytes)
    throw new RangeError("Speech request is too large.")
  if (!request.body) throw new SyntaxError("Speech request body is missing.")

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new RangeError("Speech request is too large.")
    }
    chunks.push(value)
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown
}

/** Synthesizes a WAV response after validating origin, text size, and the selected voice. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request)) {
    return Response.json(
      { error: "Speech requests must come from this Blitz app." },
      { status: 403 }
    )
  }

  let input: unknown
  try {
    input = await readBoundedBody(request)
  } catch (error) {
    const tooLarge = error instanceof RangeError
    return Response.json(
      { error: tooLarge ? error.message : "The speech request was invalid." },
      { status: tooLarge ? 413 : 400 }
    )
  }
  if (typeof input !== "object" || input === null) {
    return Response.json(
      { error: "The speech request was invalid." },
      { status: 400 }
    )
  }
  const body = input as Record<string, unknown>
  if (
    typeof body.text !== "string" ||
    !body.text.trim() ||
    body.text.length > KOKORO_MAX_TEXT_LENGTH ||
    (body.preparation !== undefined && typeof body.preparation !== "boolean") ||
    (body.preparation === true && body.text.length > SPEECH_OPENING_CHARS) ||
    !isKokoroVoiceId(body.voiceId)
  ) {
    return Response.json(
      {
        error: `Provide text up to ${KOKORO_MAX_TEXT_LENGTH.toLocaleString()} characters and a supported voice.`,
      },
      { status: 400 }
    )
  }

  try {
    const audio = await synthesizeKokoroWav({
      text: body.text,
      voiceId: body.voiceId,
      signal: request.signal,
      priority: body.preparation === true ? "preparation" : "playback",
    })
    return new Response(new Uint8Array(audio), {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 })
    const status = error instanceof KokoroUnavailableError ? 503 : 500
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kokoro could not create the audio.",
      },
      { status }
    )
  }
}
