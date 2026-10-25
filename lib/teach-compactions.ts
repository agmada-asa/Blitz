/**
 * Places a Teach session's compaction records in its lesson and words them.
 *
 * Each compaction is shown once, as a quiet divider where it happened: before
 * the reply it ran ahead of (`auto`), after the reply that ran out of room or
 * that the runtime compacted during (`overflow`, `runtime`), or between the
 * replies it fell between in time (`manual`). The divider says how full the
 * session was and how far the lesson had got, so the learner knows earlier
 * sections now live in a summary. Pure, so the Teach screen and tests agree.
 */

import { parseTeachSectionMarker, type TeachOutline } from "./teach.ts"

/** One saved compaction, as `workspaceChats.get` returns it. */
export type TeachCompactionRecord = {
  at: number
  origin: "auto" | "overflow" | "manual" | "runtime"
  fromPercent?: number
  messageId?: string
}

/** A compaction with how many outline sections had been reached before it. */
export type PlacedTeachCompaction = TeachCompactionRecord & {
  /** One-based number of the furthest section taught before the divider; 0 for none. */
  sectionsBefore: number
}

/** The lesson messages placement needs. */
type LessonMessage = { id: string; role: "user" | "assistant"; createdAt: number; content: string }

/** Key for dividers that come after every message. */
export const AFTER_LAST_MESSAGE = "end"

/**
 * Groups compactions by the message they appear before, oldest first, with
 * `AFTER_LAST_MESSAGE` for those after the last message.
 *
 * @param messages - The lesson in order.
 * @param compactions - The chat's compaction records.
 * @param outline - The agreed outline, for counting sections reached.
 */
export function placeTeachCompactions(
  messages: readonly LessonMessage[],
  compactions: readonly TeachCompactionRecord[],
  outline: TeachOutline | null
): Map<string, PlacedTeachCompaction[]> {
  const placed = new Map<string, PlacedTeachCompaction[]>()
  const ordered = [...compactions].sort((a, b) => a.at - b.at)
  for (const compaction of ordered) {
    const own = compaction.messageId
      ? messages.findIndex((message) => message.id === compaction.messageId)
      : -1
    let index: number
    if (own >= 0) index = compaction.origin === "auto" ? own : own + 1
    else {
      const later = messages.findIndex((message) => message.createdAt > compaction.at)
      index = later >= 0 ? later : messages.length
    }
    const key = messages[index]?.id ?? AFTER_LAST_MESSAGE
    let sectionsBefore = 0
    if (outline)
      for (const message of messages.slice(0, index)) {
        if (message.role !== "assistant") continue
        const marker = parseTeachSectionMarker(message.content)
        if (marker?.kind !== "section") continue
        const position = outline.sections.findIndex((section) => section.id === marker.id)
        sectionsBefore = Math.max(sectionsBefore, position + 1)
      }
    placed.set(key, [...(placed.get(key) ?? []), { ...compaction, sectionsBefore }])
  }
  return placed
}

/**
 * The divider's words, such as "Session compacted at 84% · sections 1 to 5
 * summarised · outline and plan kept".
 */
export function teachCompactionText(compaction: PlacedTeachCompaction): string {
  const at =
    compaction.fromPercent !== undefined
      ? `Session compacted at ${Math.round(compaction.fromPercent)}%`
      : "Session compacted"
  if (compaction.origin === "overflow")
    return `${at} to finish the reply above · outline and plan kept`
  const summarised =
    compaction.sectionsBefore > 1
      ? `sections 1 to ${compaction.sectionsBefore} summarised`
      : compaction.sectionsBefore === 1
        ? "section 1 summarised"
        : "earlier replies summarised"
  return `${at} · ${summarised} · outline and plan kept`
}
