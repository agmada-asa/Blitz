/** Keeps audiobook and podcast scripts in a form the local voice can read clearly. */

/** Shared writing rules for any model output that Kokoro will speak. */
export const SPOKEN_AUDIO_GUIDANCE =
  'Write only words meant to be spoken, with complete sentences and natural transitions. Skip page and slide numbers, repeated headings, QR codes, access instructions, raw URLs, and meaningless identifier strings. Keep meaningful numbers and source facts. Read "AI" as the letters A I, "ML" as M L, "LLM" as large language model, and "vs" as versus. Some PDFs extract "AI" as "Al" with a lowercase L; correct that only when the context means artificial intelligence, and keep real names unchanged. Describe a table, diagram, or image briefly only when supplied text, a caption, or alt text establishes what it shows. Do not guess unseen visual details.'

/** Forces known abbreviations into forms Kokoro reads consistently. */
export function spokenAudioText(text: string): string {
  return text
    .replace(/\bLLMs\b/g, "large language models")
    .replace(/\bLLM\b/g, "large language model")
    .replace(/\bAI\b/g, "A I")
    .replace(/\bML\b/g, "M L")
    .replace(/\bvs\.(?=\s+\w)/gi, "versus")
    .replace(/\bvs\b/gi, "versus")
    .replace(/\s+/g, " ")
    .trim()
}
