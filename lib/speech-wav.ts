/**
 * The one audio format Blitz's speech to text takes: 16 kHz mono 16-bit PCM
 * WAV with the canonical 44-byte header. The browser encodes it
 * (`lib/client/speech-recording.ts`) and the server checks it
 * (`lib/server/speech-to-text.ts`) before the on-device model reads it.
 */

/** Sample rate the speech-to-text model expects. */
export const SPEECH_SAMPLE_RATE = 16_000

/** Longest recording, in seconds; the browser stops and the server refuses past it. */
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

/** Longest recording accepted: two minutes of 16 kHz mono 16-bit audio, plus header. */
export const MAX_SPEECH_RECORDING_BYTES =
  MAX_RECORDING_SECONDS * SPEECH_SAMPLE_RATE * 2 + 44

/** A recording Blitz cannot accept, with copy the learner can act on. */
export class SpeechRecordingError extends Error {
  /** Creates one recording error with its recovery copy. */
  constructor(message: string) {
    super(message)
    this.name = "SpeechRecordingError"
  }
}

/** Reads an ASCII tag from a byte buffer. */
function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}

/**
 * Checks that a recording is a WAV file the worker can read: RIFF/WAVE with
 * 16-bit PCM, mono, at 16 kHz, within the size bound.
 *
 * @throws SpeechRecordingError with recovery copy when it is not.
 */
export function validateSpeechWav(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_SPEECH_RECORDING_BYTES)
    throw new SpeechRecordingError("That recording is too long. Keep questions under two minutes.")
  if (bytes.byteLength <= 44 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE")
    throw new SpeechRecordingError("That recording could not be read. Try again.")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The browser writes the canonical 44-byte header: fmt chunk first.
  const format = view.getUint16(20, true)
  const channels = view.getUint16(22, true)
  const sampleRate = view.getUint32(24, true)
  const bitsPerSample = view.getUint16(34, true)
  if (
    tag(bytes, 12) !== "fmt " ||
    format !== 1 ||
    channels !== 1 ||
    sampleRate !== 16_000 ||
    bitsPerSample !== 16
  )
    throw new SpeechRecordingError("That recording could not be read. Try again.")
}

