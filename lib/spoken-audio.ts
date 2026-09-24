/** Keeps readable audio scripts separate from the words sent to Kokoro. */

/** One literal term in the readable script and its English pronunciation spelling. */
export type AudioPronunciation = { written: string; spoken: string }

/** Shared writing rules for audiobook and podcast scripts. */
export const SPOKEN_AUDIO_GUIDANCE =
  'Write the reader-facing text in ordinary spelling, with complete sentences and natural transitions. Skip page and slide numbers, repeated headings, QR codes, access instructions, raw URLs, and meaningless identifier strings. Keep meaningful numbers and source facts. Return a pronunciation entry for each unusual name, proper noun, technical term, and acronym whose spelling Kokoro may misread. Each entry must quote the exact written form in the text and give an English phonetic respelling made of ordinary words or syllables, such as {"written":"AI","spoken":"eigh eye"}. Keep the same pronunciation across sections. Spell "vs" as "versus" in the reader-facing text. Some PDFs extract "AI" as "Al" with a lowercase L; correct that only when the context means artificial intelligence, and keep real names unchanged. Describe a table, diagram, or image briefly only when supplied text, a caption, or alt text establishes what it shows. Do not guess unseen visual details.'

/** Known terms override model suggestions after local phonemizer verification. */
const DEFAULT_PRONUNCIATIONS: AudioPronunciation[] = [
  { written: "LLMs", spoken: "ell ell ems" },
  { written: "LLM", spoken: "ell ell em" },
  { written: "AI", spoken: "eigh eye" },
  { written: "ML", spoken: "em ell" },
  { written: "vs.", spoken: "versus" },
  { written: "vs", spoken: "versus" },
]

/** Escapes a literal source term before matching it in a readable passage. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Builds the exact speech input while preserving the visible script unchanged. */
export function spokenAudioText(
  text: string,
  pronunciations: readonly AudioPronunciation[] = []
): string {
  const defaults = new Set(DEFAULT_PRONUNCIATIONS.map((entry) => entry.written))
  const entries = [
    ...DEFAULT_PRONUNCIATIONS,
    ...pronunciations.filter((entry) => !defaults.has(entry.written)),
  ]
    .filter((entry) => entry.written.trim() && entry.spoken.trim())
    .sort((left, right) => right.written.length - left.written.length)
  if (!entries.length) return text.replace(/\s+/g, " ").trim()
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${entries.map((entry) => escapeRegExp(entry.written)).join("|")})(?![\\p{L}\\p{N}])`,
    "gu"
  )
  const replacements = new Map(
    entries.map((entry) => [entry.written, entry.spoken])
  )
  return text
    .replace(pattern, (match) => replacements.get(match) ?? match)
    .replace(/\s+/g, " ")
    .trim()
}
