/**
 * Records a spoken question in the browser and sends it to Blitz's local
 * speech-to-text route (`/api/audio/transcribe`).
 *
 * The microphone is open only while the learner is recording. The recording
 * is mixed to mono, resampled to 16 kHz and encoded as 16-bit PCM WAV here,
 * which is the one format the on-device model reads, so the server needs no
 * audio decoder.
 */

import {
  encodePcm16Wav,
  MAX_RECORDING_SECONDS,
  SPEECH_SAMPLE_RATE,
} from "../speech-wav.ts"

/**
 * Decodes a recorded clip and renders it as 16 kHz mono samples.
 *
 * @param recording - The recorder's compressed clip.
 */
async function toSpeechSamples(recording: Blob): Promise<Float32Array> {
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(await recording.arrayBuffer())
    const length = Math.max(1, Math.ceil(decoded.duration * SPEECH_SAMPLE_RATE))
    // An offline mono context mixes the channels down and resamples in one pass.
    const offline = new OfflineAudioContext(1, length, SPEECH_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return (await offline.startRendering()).getChannelData(0)
  } finally {
    void decoder.close()
  }
}

/** A recording in progress. */
export interface SpeechRecording {
  /** Stops recording and resolves with 16 kHz mono WAV bytes. */
  stop(): Promise<Uint8Array>
  /** Stops recording and discards it. */
  cancel(): void
}

/**
 * Opens the microphone and starts recording one question.
 *
 * Recording stops by itself after {@link MAX_RECORDING_SECONDS}; `stop` then
 * returns what was recorded.
 *
 * @throws DOMException `NotAllowedError` when microphone access is refused,
 *   or `NotFoundError` when there is no microphone.
 */
export async function startSpeechRecording(): Promise<SpeechRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  })
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  /** Ends the recorder and releases the microphone. */
  const end = () => {
    if (recorder.state !== "inactive") recorder.stop()
    for (const track of stream.getTracks()) track.stop()
  }
  const limit = setTimeout(end, MAX_RECORDING_SECONDS * 1_000)
  recorder.start()
  return {
    async stop() {
      clearTimeout(limit)
      end()
      await stopped
      return encodePcm16Wav(
        await toSpeechSamples(new Blob(chunks, { type: recorder.mimeType }))
      )
    },
    cancel() {
      clearTimeout(limit)
      end()
    },
  }
}

/**
 * Starts the local speech-to-text model ahead of the first question, so it
 * loads (or, the first time, downloads) while the learner is still speaking.
 * Failures are left for the transcription request to report.
 */
export function warmSpeechToText(): void {
  void fetch("/api/audio/transcribe?warm=1", { method: "POST" }).catch(
    () => undefined
  )
}

/**
 * Sends one recording to the local model and returns its text.
 *
 * @param wav - 16 kHz mono WAV bytes from {@link SpeechRecording.stop}.
 * @param signal - Cancels the request.
 * @throws Error with the server's recovery copy when transcription fails.
 */
export async function transcribeRecording(
  wav: Uint8Array,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch("/api/audio/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav as BodyInit,
    ...(signal ? { signal } : {}),
  })
  const body = (await response.json().catch(() => ({}))) as {
    text?: unknown
    error?: unknown
  }
  if (!response.ok || typeof body.text !== "string")
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "That recording could not be turned into text. Try again."
    )
  return body.text
}
