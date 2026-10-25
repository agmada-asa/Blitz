/** Checks the WAV format shared by Teach dictation and the local speech-to-text route. */

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  encodePcm16Wav,
  MAX_SPEECH_RECORDING_BYTES,
  SpeechRecordingError,
  validateSpeechWav,
} from "../lib/speech-wav.ts"

test("a recording encodes as 16 kHz mono 16-bit WAV that the server accepts", () => {
  const wav = encodePcm16Wav(new Float32Array([0, 0.5, -0.5, 2, -2]))
  assert.equal(wav.byteLength, 44 + 5 * 2)
  const view = new DataView(wav.buffer)
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF")
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getUint32(40, true), 10)
  // Samples are scaled to 16 bits and clipped to full scale.
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => view.getInt16(44 + index * 2, true)),
    [0, 16383, -16384, 32767, -32768]
  )
  assert.doesNotThrow(() => validateSpeechWav(wav))
})

test("the server refuses other formats, empty files and recordings over two minutes", () => {
  const rejects = (bytes: Uint8Array, pattern: RegExp) =>
    assert.throws(
      () => validateSpeechWav(bytes),
      (error: unknown) =>
        error instanceof SpeechRecordingError && pattern.test(error.message)
    )
  rejects(encodePcm16Wav(new Float32Array(10), 44_100), /could not be read/)
  const stereo = encodePcm16Wav(new Float32Array(10))
  new DataView(stereo.buffer).setUint16(22, 2, true)
  rejects(stereo, /could not be read/)
  rejects(encodePcm16Wav(new Float32Array(0)), /could not be read/)
  rejects(new TextEncoder().encode("not audio at all, just some text here....."), /could not be read/)
  rejects(new Uint8Array(MAX_SPEECH_RECORDING_BYTES + 1), /too long/)
})
