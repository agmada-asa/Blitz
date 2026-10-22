/** Keeps readable audio scripts separate from the words sent to Kokoro. */

/** One locally checked abbreviation and its English pronunciation spelling. */
type AudioPronunciation = { written: string; spoken: string }

/** Shared writing rules for audiobook and podcast scripts. */
export const SPOKEN_AUDIO_GUIDANCE =
  'Write the text in ordinary spelling, with complete sentences and natural transitions. Keep words, technical terms, names, and acronyms in their normal written form. The speech engine handles pronunciation. Do not add phonetic respellings, syllable breaks, or pronunciation guides, even for unfamiliar terms. Skip page and slide numbers, repeated headings, QR codes, access instructions, raw URLs, and meaningless identifier strings. Keep meaningful numbers and source facts. Spell "vs" as "versus" in the text. Some PDFs extract "AI" as "Al" with a lowercase L; correct that only when the context means artificial intelligence, and keep real names unchanged. Describe a table, diagram, or image briefly only when supplied text, a caption, or alt text establishes what it shows. Do not guess unseen visual details.'

/** Only locally verified corrections may override the speech engine's pronunciation. */
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

/** Preserves normal words for Kokoro, applying only the checked abbreviation list. */
export function spokenAudioText(text: string): string {
  // Model-generated respellings split familiar words into separately spoken syllables.
  const entries = [...DEFAULT_PRONUNCIATIONS].sort(
    (left, right) => right.written.length - left.written.length
  )
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
