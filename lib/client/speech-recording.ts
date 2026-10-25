/**
 * Records a spoken question in the browser and sends it to Blitz's local
 * speech-to-text route (`/api/audio/transcribe`).
 *
 * The microphone is open only while the learner is recording. The recording
 * is mixed to mono, resampled to 16 kHz and encoded as 16-bit PCM WAV here,
 * which is the one format the on-device model reads, so the server needs no
 * audio decoder.
 */

/** Sample rate the speech-to-text model expects. */
export const SPEECH_SAMPLE_RATE = 16_000

/** Longest recording, matching the server's bound. */
export const MAX_RECORDING_SECONDS = 120

/**
 * Encodes mono samples in [-1, 1] as a 16-bit PCM WAV file.
 *
 * @param samples - Mono samples at `sampleRate`; values outside [-1, 1] are clipped.
 * @param sampleRate - Samples per second.
 * @returns The WAV bytes, with the canonical 44-byte header.
 */
export function encodePcm16Wav(
  samples: Float32Array,
  sampleRate = SPEECH_SAMPLE_RATE
): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  /** Writes a four-letter chunk tag. */
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < 4; index += 1)
      view.setUint8(offset + index, value.charCodeAt(index))
  }
  tag(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  tag(8, "WAVE")
  tag(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}

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
