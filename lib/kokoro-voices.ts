/** Defines the Kokoro voices offered in settings and validates saved voice IDs. */

/** Stable voice identifiers supported by the local Kokoro runtime. */
export const KOKORO_VOICE_IDS = [
  "af_heart",
  "af_bella",
  "af_nicole",
  "am_fenrir",
  "am_puck",
] as const

/** Voice identifier accepted by the speech endpoint and saved audio settings. */
export type KokoroVoiceId = (typeof KOKORO_VOICE_IDS)[number]

/** Metadata used to present a Kokoro voice and its short listening preview. */
export const KOKORO_VOICES: ReadonlyArray<{
  id: KokoroVoiceId
  name: string
  description: string
}> = [
  { id: "af_heart", name: "Heart", description: "Warm and expressive" },
  { id: "af_bella", name: "Bella", description: "Bright and clear" },
  { id: "af_nicole", name: "Nicole", description: "Calm and measured" },
  { id: "am_fenrir", name: "Fenrir", description: "Low and steady" },
  { id: "am_puck", name: "Puck", description: "Lively and conversational" },
]

/** Checks whether an untrusted value is one of the supported Kokoro voice IDs. */
export function isKokoroVoiceId(value: unknown): value is KokoroVoiceId {
  return (
    typeof value === "string" &&
    (KOKORO_VOICE_IDS as readonly string[]).includes(value)
  )
}

/** Validates that one or two unique Kokoro voices are selected, preserving order. */
export function validateKokoroVoiceIds(value: unknown): KokoroVoiceId[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    !value.every(isKokoroVoiceId) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Choose one or two different Kokoro voices.")
  }
  return [...value]
}
