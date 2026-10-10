/**
 * Names the unit an approved research import creates when the learner did not
 * pick an existing one. Kept dependency-free so Convex mutations can import it.
 *
 * The title is provisional: units created this way are `auto` titled, so the
 * tutor replaces it with its outline title when the unit is first taught.
 */

/** Longest research unit title, matching the room the module page gives unit titles. */
const MAX_RESEARCH_UNIT_TITLE = 80

/** Request openers that describe the learner rather than the topic. */
const REQUEST_OPENERS =
  /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:help\s+me(?:\s+to)?|i\s+(?:want|need|would\s+like)\s+to|teach\s+me|show\s+me)\b\s*)?(?:(?:learn|understand|study|revise|get\s+better\s+at)\b\s*)?(?:about\s+|the\s+basics\s+of\s+)?/i

/**
 * Suggests a unit title from a research request, falling back to its first
 * topic and then to `Research`.
 *
 * @param request The learner's words, such as `help me learn sound design`.
 * @param topics Topic names from the ready proposal.
 * @returns A sentence-case title of at most 80 characters, cut at a word.
 */
export function researchUnitTitle(
  request: string,
  topics: readonly string[] = []
): string {
  const topic = request
    .replace(/\s+/g, " ")
    .trim()
    .replace(REQUEST_OPENERS, "")
    .replace(/[.?!]+$/, "")
    .trim()
  const title = topic || topics[0]?.trim() || "Research"
  let bounded = title
  if (bounded.length > MAX_RESEARCH_UNIT_TITLE) {
    const space = bounded.lastIndexOf(" ", MAX_RESEARCH_UNIT_TITLE)
    bounded = bounded.slice(0, space > 20 ? space : MAX_RESEARCH_UNIT_TITLE)
  }
  return bounded.charAt(0).toUpperCase() + bounded.slice(1)
}
