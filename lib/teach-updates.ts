/**
 * Owns the rules for updating a Teach lesson when new files reach its unit:
 * which sources the lesson has not seen, how a revised outline is merged into
 * the one the learner is part way through, and what `Next section` teaches
 * afterwards.
 *
 * A lesson is a live conversation, so nothing here rewrites what was taught.
 * Every existing section keeps its id, progress and earlier replies; a section
 * the new files change is queued to be taught again, and a section they add is
 * queued to be taught for the first time. Dependency-free (types aside) so
 * Convex, the server route, the Teach screen and tests all share one set of
 * rules.
 */

import { NEXT_SECTION } from "./teach-focus.ts"
import {
  MAX_SECTION_CONCEPTS,
  MAX_UPDATED_TEACH_SECTIONS,
} from "./teach-limits.ts"
import type {
  TeachOutline,
  TeachSection,
  TeachSectionMode,
  TeachSectionPlan,
} from "./teach.ts"

/**
 * How long a running update holds its lesson. Longer than the provider's own
 * timeout, so only an update whose server died outlives it.
 */
export const TEACH_UPDATE_LEASE_MS = 10 * 60 * 1_000

/** Update records kept on a lesson; older ones lose only their divider. */
export const MAX_TEACH_UPDATE_RECORDS = 20

/** How the new files changed a section. */
export type TeachSectionChange = "updated" | "added"

/** A section waiting to be taught because of an update. */
export type TeachPendingSection = {
  id: string
  change: TeachSectionChange
  /** What the new files change, passed to the tutor when it teaches the section. */
  note: string
}

/** One finished update, shown as a divider where it happened in the lesson. */
export type TeachUpdateRecord = {
  at: number
  filenames: string[]
  summary: string
  sections: Array<{ id: string; change: TeachSectionChange }>
}

/** An update in progress, or the one that last failed. */
export type TeachUpdateRun = {
  status: "running" | "failed"
  startedAt: number
  sourceIds: string[]
  error?: string
}

/** The source facts needed to tell whether a lesson has seen a file. */
export type TeachUpdateSource = {
  id: string
  filename: string
  status: string
  hasText: boolean
  unsupported: boolean
  createdAt: number
}

/** One section of the analysis the model returns, in its proposed order. */
export type TeachUpdateReplySection = {
  /** The existing section's id; empty for an added section. */
  id: string
  title: string
  concepts: string[]
  change: "unchanged" | TeachSectionChange
  note: string
}

/** The model's validated analysis of how new files change an outline. */
export type TeachUpdateReply = {
  summary: string
  sections: TeachUpdateReplySection[]
}

/** The lesson state an update is merged into. */
export type TeachUpdateState = {
  outline: TeachOutline
  plan?: TeachSectionPlan
  /** Zero-based current section; the section count once the unit is complete. */
  sectionIndex: number
  taughtSectionIds: string[]
  pending: TeachPendingSection[]
  /** Updates already applied, so an added section's id stays unique. */
  updateCount: number
}

/** The lesson state after merging an update. */
export type TeachUpdateResult = {
  outline: TeachOutline
  plan?: TeachSectionPlan
  sectionIndex: number
  pending: TeachPendingSection[]
  sections: TeachUpdateRecord["sections"]
  /** Added sections that did not fit under the outline's limit. */
  dropped: number
}

/** What a `Next section` turn should teach once a lesson has been updated. */
export type TeachNextTarget =
  | {
      kind: "section"
      index: number
      section: TeachSection
      pending?: TeachPendingSection
    }
  | { kind: "done" }

/** A reply's section marker, as read from a saved message. */
export type TeachReplyMarker = {
  id: string
  createdAt: number
  /** Section id the reply teaches, or undefined for any other reply. */
  sectionId?: string
  /** True for the end-of-unit recap. */
  done?: boolean
}

/** Longest note kept for one changed section. */
const MAX_NOTE = 500

/**
 * Returns the unit's readable files the lesson has not seen yet.
 *
 * Lessons planned before updates existed have no record of what they covered,
 * so the session's own start date stands in: anything older was in its first
 * prompt. Files still being read, unreadable, or without text are not offered
 * until they can actually change the lesson.
 *
 * @param coveredSourceIds Sources the lesson's outline reflects, when recorded.
 * @param startedAt When the Teach session was created.
 * @param sources The unit's sources.
 * @returns The new sources, oldest first.
 */
export function teachNewSources<T extends TeachUpdateSource>(
  coveredSourceIds: readonly string[] | undefined,
  startedAt: number,
  sources: readonly T[]
): T[] {
  const covered = coveredSourceIds ? new Set(coveredSourceIds) : undefined
  return sources
    .filter((source) => {
      if (source.status !== "ready" || !source.hasText || source.unsupported)
        return false
      return covered ? !covered.has(source.id) : source.createdAt > startedAt
    })
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * Returns whether an update currently holds its lesson. An update whose server
 * stopped is released by its lease, so the learner can try again.
 *
 * @param run The lesson's latest update run, if any.
 * @param now The caller's clock; queries cannot read a live one.
 */
export function isTeachUpdateRunning(
  run: Pick<TeachUpdateRun, "status" | "startedAt"> | null | undefined,
  now: number
): boolean {
  return run?.status === "running" && run.startedAt > now - TEACH_UPDATE_LEASE_MS
}

/** Keeps a section's valid, distinct concept names, up to the section limit. */
function cleanConcepts(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const entry of names) {
    const name = entry.replace(/\s+/g, " ").trim().slice(0, 80)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    kept.push(name)
    if (kept.length >= MAX_SECTION_CONCEPTS) break
  }
  return kept
}

/** Bounds a model-written note to one short line. */
function cleanNote(note: string): string {
  return note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE)
}

/** Compares titles the way a learner would, ignoring case and spacing. */
function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase()
}

/**
 * Merges the model's analysis into the lesson, keeping everything the learner
 * has done.
 *
 * The reply is only trusted for what it can add. Every existing section stays,
 * in its existing order, even when the reply leaves it out; a taught section
 * keeps its title and only gains concepts, so earlier replies still read
 * correctly. Added sections go after the existing section they followed in the
 * reply. Sections already taught that the files change are queued again.
 *
 * @param state The lesson as it stands.
 * @param reply The validated analysis.
 * @returns The new lesson state, with the changes made and anything dropped.
 */
export function mergeTeachUpdate(
  state: TeachUpdateState,
  reply: TeachUpdateReply
): TeachUpdateResult {
  const existing = new Map(state.outline.sections.map((section) => [section.id, section]))
  const byTitle = new Map(
    state.outline.sections.map((section) => [titleKey(section.title), section.id])
  )
  const taught = new Set(state.taughtSectionIds)
  const changed = new Map<string, TeachUpdateReplySection>()
  /** Added sections, keyed by the existing section they come after. */
  const addedAfter = new Map<string | null, TeachUpdateReplySection[]>()
  const addedTitles = new Set<string>()
  let anchor: string | null = null
  let added = 0
  let dropped = 0
  const room = Math.max(0, MAX_UPDATED_TEACH_SECTIONS - state.outline.sections.length)

  for (const entry of reply.sections) {
    // A wrong id with a known title is still that section, not a new topic.
    const id = existing.has(entry.id) ? entry.id : byTitle.get(titleKey(entry.title))
    if (id && !changed.has(id)) {
      changed.set(id, entry)
      anchor = id
      continue
    }
    if (id || entry.change !== "added") continue
    const key = titleKey(entry.title)
    if (!key || addedTitles.has(key)) continue
    addedTitles.add(key)
    if (added >= room) {
      dropped += 1
      continue
    }
    added += 1
    addedAfter.set(anchor, [...(addedAfter.get(anchor) ?? []), entry])
  }

  const sections: TeachSection[] = []
  const pending = new Map<string, TeachPendingSection>()
  // Sections still waiting from an earlier update keep their place in the queue.
  for (const entry of state.pending)
    if (existing.has(entry.id)) pending.set(entry.id, entry)
  const record: TeachUpdateRecord["sections"] = []
  let nextId = 1

  /** Appends the sections added after `after`, giving each a fresh id. */
  const appendAdded = (after: string | null) => {
    for (const entry of addedAfter.get(after) ?? []) {
      const id = `u${state.updateCount + 1}n${nextId++}`
      const concepts = cleanConcepts(entry.concepts)
      sections.push({
        id,
        title: entry.title.replace(/\s+/g, " ").trim().slice(0, 160),
        ...(concepts.length ? { concepts } : {}),
      })
      pending.set(id, { id, change: "added", note: cleanNote(entry.note) })
      record.push({ id, change: "added" })
    }
  }

  appendAdded(null)
  for (const [position, section] of state.outline.sections.entries()) {
    const entry = changed.get(section.id)
    if (entry?.change !== "updated") sections.push(section)
    else {
      const wasTaught = taught.has(section.id)
      const concepts = cleanConcepts(
        wasTaught ? [...(section.concepts ?? []), ...entry.concepts] : entry.concepts
      )
      sections.push({
        ...section,
        // A title can only change before the learner has seen it.
        title: wasTaught
          ? section.title
          : entry.title.replace(/\s+/g, " ").trim().slice(0, 160) || section.title,
        ...(concepts.length ? { concepts } : {}),
      })
      // A section still ahead teaches the new material when it is reached; one
      // already passed, even untaught after a jump or a skip, has to be queued.
      if (wasTaught || position < state.sectionIndex || pending.has(section.id))
        pending.set(section.id, {
          id: section.id,
          change: pending.get(section.id)?.change ?? "updated",
          // A second update adds to what the section is still waiting to cover.
          note: cleanNote(`${pending.get(section.id)?.note ?? ""} ${entry.note}`),
        })
      record.push({ id: section.id, change: "updated" })
    }
    appendAdded(section.id)
  }

  const previousLength = state.outline.sections.length
  let sectionIndex: number
  if (state.sectionIndex >= previousLength)
    // A finished unit stays finished only when there is nothing new to teach;
    // otherwise it rests on its last section so `Next section` carries on.
    sectionIndex =
      pending.size || added
        ? sections.findIndex(
            (section) =>
              section.id === state.outline.sections[previousLength - 1].id
          )
        : sections.length
  else
    sectionIndex = sections.findIndex(
      (section) => section.id === state.outline.sections[state.sectionIndex].id
    )

  return {
    outline: { title: state.outline.title, sections },
    ...(state.plan
      ? { plan: mergePlan(state.plan, sections, changed) }
      : {}),
    sectionIndex,
    pending: sections.flatMap((section) => {
      const entry = pending.get(section.id)
      return entry ? [entry] : []
    }),
    sections: record,
    dropped,
  }
}

/**
 * Carries the pre-check plan across the new outline. Added sections are taught.
 * A section the check marked as known but the files changed is at least skimmed,
 * because the learner has not shown they know the new part.
 */
function mergePlan(
  plan: TeachSectionPlan,
  sections: TeachSection[],
  changed: ReadonlyMap<string, TeachUpdateReplySection>
): TeachSectionPlan {
  const modes = new Map(plan.map((entry) => [entry.id, entry.mode]))
  return sections.map((section) => {
    const mode: TeachSectionMode = modes.get(section.id) ?? "teach"
    return {
      id: section.id,
      mode:
        mode === "skip" && changed.get(section.id)?.change === "updated"
          ? "skim"
          : mode,
    }
  })
}

/**
 * Chooses what `Next section` teaches in a lesson that has been updated.
 *
 * Sections the files changed come first, along with added sections the learner
 * has already gone past. Then the lesson carries on from where it was with the
 * next section not yet taught, skipping any the pre-check marked as known.
 *
 * @param state The lesson's outline, plan, progress and queue.
 * @returns The section to teach, or `done` when only the recap is left.
 */
export function nextTeachTarget(state: {
  outline: TeachOutline
  plan?: TeachSectionPlan | null
  taughtSectionIds: ReadonlySet<string>
  pending: readonly TeachPendingSection[]
  sectionIndex: number
}): TeachNextTarget {
  const pending = new Map(state.pending.map((entry) => [entry.id, entry]))
  const overdue = state.outline.sections.findIndex((section, index) => {
    const entry = pending.get(section.id)
    return entry && (entry.change === "updated" || index <= state.sectionIndex)
  })
  if (overdue >= 0) {
    const section = state.outline.sections[overdue]
    return { kind: "section", index: overdue, section, pending: pending.get(section.id) }
  }
  const modes = new Map(state.plan?.map((entry) => [entry.id, entry.mode]))
  const ahead = state.outline.sections.findIndex(
    (section, index) =>
      index > state.sectionIndex &&
      !state.taughtSectionIds.has(section.id) &&
      modes.get(section.id) !== "skip"
  )
  if (ahead < 0) return { kind: "done" }
  const section = state.outline.sections[ahead]
  return { kind: "section", index: ahead, section, pending: pending.get(section.id) }
}

/** Words the instruction for teaching one section after an update. */
function sectionInstruction(index: number, target: Extract<TeachNextTarget, { kind: "section" }>): string {
  const { section, pending } = target
  const opening = `Teach section ${index + 1}: ${section.title}. Begin with a section block for ${section.id} and follow the protocol.`
  if (pending?.change === "updated")
    return `${opening} New course material changed this section. What changed, according to Blitz's analysis of the new files: ${pending.note || "see the new material."} Teach the section as it now stands from all the material. If you have already taught it, go through what is new or different properly and keep what the learner already saw brief. Write new quiz questions.`
  if (pending?.change === "added")
    return `${opening} This section was added because of new course material: ${pending.note || "see the new material."} Teach it in full.`
  return opening
}

/**
 * Turns a learner's navigation into an explicit instruction once the lesson
 * has been updated. The protocol's "next in the outline" is wrong by then, as
 * the lesson may need to go back over a changed section first, so Blitz decides
 * and tells the tutor.
 *
 * @param message The learner's message for this turn.
 * @param state The lesson's outline, plan, progress and queue.
 * @returns The message to send the tutor, with the section it teaches when
 *   there is one, or undefined to send the learner's message unchanged.
 */
export function teachUpdateInstruction(
  message: string,
  state: Parameters<typeof nextTeachTarget>[0]
): { message: string; focus?: string } | undefined {
  const trimmed = message.trim()
  if (trimmed.toLowerCase() === NEXT_SECTION) {
    const target = nextTeachTarget(state)
    if (target.kind === "done")
      return {
        message:
          "Every section is now covered. Send the ```section block with body done, the short recap of the unit's key ideas including anything the new material added, and the final mixed quiz.",
      }
    return {
      message: sectionInstruction(target.index, target),
      focus: target.section.title,
    }
  }
  const jump = /^Teach section (\d+):/i.exec(trimmed)
  if (!jump) return undefined
  const index = Number(jump[1]) - 1
  const section = state.outline.sections[index]
  const pending = section && state.pending.find((entry) => entry.id === section.id)
  if (!section || !pending) return undefined
  return {
    message: sectionInstruction(index, { kind: "section", index, section, pending }),
    focus: section.title,
  }
}

/**
 * Follows a lesson's position through its saved replies. Markers written before
 * the latest update describe the old outline's position, so they count as taught
 * but no longer move the learner; the update already placed them.
 *
 * @param state The saved position, the update time and the outline's length.
 * @param markers Each reply's section marker, in order.
 * @returns The position to show, the sections taught, and what is still queued.
 */
export function followTeachReplies(
  state: {
    sectionIndex: number
    taughtSectionIds: readonly string[]
    pending: readonly TeachPendingSection[]
    lastUpdateAt: number
    sections: readonly { id: string }[]
  },
  markers: readonly TeachReplyMarker[]
): {
  sectionIndex: number
  taughtSectionIds: Set<string>
  pending: TeachPendingSection[]
} {
  const taught = new Set(state.taughtSectionIds)
  let sectionIndex = state.sectionIndex
  const taughtSince = new Set<string>()
  for (const marker of markers) {
    if (marker.done && marker.createdAt > state.lastUpdateAt) sectionIndex = state.sections.length
    if (!marker.sectionId) continue
    const found = state.sections.findIndex((section) => section.id === marker.sectionId)
    if (found < 0) continue
    taught.add(marker.sectionId)
    if (marker.createdAt <= state.lastUpdateAt) continue
    sectionIndex = found
    taughtSince.add(marker.sectionId)
  }
  return {
    sectionIndex,
    taughtSectionIds: taught,
    pending: state.pending.filter((entry) => !taughtSince.has(entry.id)),
  }
}

/** A reply's relationship to the lesson updates, as shown beside its heading. */
export type TeachReplyUpdateLabel = "updated" | "added" | "superseded"

/**
 * Labels the replies an update affected: the first reply teaching a changed or
 * added section after the update, and the earlier version it replaced.
 *
 * @param markers Each reply's section marker, in order.
 * @param updates The lesson's update records, oldest first.
 * @returns Labels keyed by message id; replies with no label are left out.
 */
export function teachReplyUpdateLabels(
  markers: readonly TeachReplyMarker[],
  updates: readonly TeachUpdateRecord[]
): Map<string, TeachReplyUpdateLabel> {
  const labels = new Map<string, TeachReplyUpdateLabel>()
  for (const update of updates)
    for (const change of update.sections) {
      const replies = markers.filter((marker) => marker.sectionId === change.id)
      const fresh = replies.find((marker) => marker.createdAt > update.at)
      if (!fresh) continue
      labels.set(fresh.id, change.change)
      for (const reply of replies)
        if (reply.createdAt < update.at) labels.set(reply.id, "superseded")
    }
  return labels
}

/** Words the divider for one finished update. */
export function teachUpdateDividerText(record: TeachUpdateRecord): string {
  const updated = record.sections.filter((entry) => entry.change === "updated").length
  const added = record.sections.length - updated
  const files =
    record.filenames.length === 1
      ? record.filenames[0]
      : `${record.filenames.length} new files`
  const parts = [
    updated ? `${updated} section${updated === 1 ? "" : "s"} updated` : "",
    added ? `${added} section${added === 1 ? "" : "s"} added` : "",
  ].filter(Boolean)
  return `Lesson updated from ${files}. ${parts.length ? parts.join(", ") : "No sections needed changing"}.`
}
