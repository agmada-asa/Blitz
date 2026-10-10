/**
 * Works out what a Teach turn is about so the right source passages can be
 * offered as citations. Kept dependency-free so Convex queries can import it.
 */

/** Quick-reply wording that advances to the next section. Mirrors `TEACH_QUICK_REPLIES.next`. */
const NEXT_SECTION = "next section"

/** Outline shape needed to resolve a turn's focus. */
type FocusOutline = { title: string; sections: Array<{ id: string; title: string }> }

/**
 * Returns search text describing what the tutor will teach next.
 *
 * "Next section" resolves to the following outline section's title, a jump
 * ("Teach section 3: …") to that section's title, and any other message to
 * itself plus the current section title for context. Before an outline exists
 * the unit is being introduced, so no focus is needed.
 *
 * @param message The learner's message for this turn.
 * @param outline The session outline, when the tutor has proposed one.
 * @param sectionIndex Zero-based furthest section taught so far.
 */
export function teachTurnFocus(
  message: string,
  outline: FocusOutline | undefined,
  sectionIndex: number | undefined
): string | undefined {
  if (!outline) return undefined
  const current = outline.sections[Math.min(sectionIndex ?? 0, outline.sections.length - 1)]
  const trimmed = message.trim()
  if (trimmed.toLowerCase() === NEXT_SECTION) {
    const next = outline.sections[(sectionIndex ?? 0) + 1]
    return next?.title ?? outline.title
  }
  const jump = /^Teach section (\d+):/i.exec(trimmed)
  if (jump) return outline.sections[Number(jump[1]) - 1]?.title ?? trimmed
  return `${trimmed} ${current?.title ?? ""}`.trim()
}
