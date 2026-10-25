/**
 * Turns a spoken question into text on the Mac, for dictation in Teach.
 *
 * `POST` with a 16 kHz mono WAV body returns `{ text }`. `POST ?warm=1` with
 * no body starts the local model ahead of the first question, which on first
 * use downloads it. Audio never leaves the Mac and is not kept.
 */

import { KokoroUnavailableError } from "@/lib/server/kokoro"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import {
  MAX_SPEECH_RECORDING_BYTES,
  SpeechRecordingError,
  transcribeSpeech,
  warmSpeechToText,
} from "@/lib/server/speech-to-text"

/** Runs local model inference in the Node.js process environment. */
export const runtime = "nodejs"

/**
 * Reads a request body up to the recording bound.
 *
 * @throws SpeechRecordingError when the body is larger than one recording may be.
 */
async function readRecording(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > MAX_SPEECH_RECORDING_BYTES)
    throw new SpeechRecordingError("That recording is too long. Keep questions under two minutes.")
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_SPEECH_RECORDING_BYTES)
    throw new SpeechRecordingError("That recording is too long. Keep questions under two minutes.")
  return bytes
}

/** Transcribes one recording, or warms the model, after checking the request's origin. */
export async function POST(request: Request): Promise<Response> {
  if (!isTrustedBlitzOrigin(request))
    return Response.json(
      { error: "Speech requests must come from this Blitz app." },
      { status: 403 }
    )
  try {
    if (new URL(request.url).searchParams.get("warm") === "1") {
      await warmSpeechToText()
      return Response.json({ ready: true })
    }
    const recording = await readRecording(request)
    const text = await transcribeSpeech(recording, request.signal)
    return Response.json({ text }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    if (error instanceof KokoroUnavailableError)
      return Response.json({ error: error.message }, { status: 503 })
    if (error instanceof DOMException && error.name === "AbortError")
      return Response.json({ error: "Transcription stopped." }, { status: 499 })
    if (error instanceof SpeechRecordingError)
      return Response.json({ error: error.message }, { status: 400 })
    console.error("Speech to text failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return Response.json(
      { error: "That recording could not be turned into text. Try again." },
      { status: 500 }
    )
  }
}
