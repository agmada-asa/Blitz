/**
 * Owns a module's units: the weeks or lectures that uploads are grouped into,
 * their Teach sessions, and the progress shown on the Learn screen.
 *
 * Teach sessions are workspace chats with `purpose: "teach"`, so streaming,
 * pausing, citations, and provider sessions reuse the chat pipeline. This file
 * only creates them, supplies their unit context, and records outline progress.
 */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { passageScore } from "../lib/citations"
import { teachTurnFocus } from "../lib/teach-focus"
import { searchTerms } from "../lib/search-terms"
import { conceptStrength } from "../lib/drill"
import { teachOutlineFields, teachSectionPlanFields } from "./teachFields"

/** Reference-book passages added to one Teach turn. */
const MAX_REFERENCE_EXCERPTS = 6

/** Characters kept from each reference passage. */
const MAX_REFERENCE_EXCERPT_TEXT = 2_500

/** Longest unit title accepted from the learner or the tutor. */
const MAX_UNIT_TITLE = 160

/** Most source chunks offered to a Teach turn as citable passages. */
const MAX_TEACH_CITATION_CHUNKS = 60

/** Chunks read per source when ranking citation candidates. */
const MAX_CHUNKS_SCANNED_PER_SOURCE = 150

/** Characters of extracted text returned per source for the Teach prompt. */
const MAX_TEACH_SOURCE_TEXT = 400_000

/** Trims a title and rejects empty or oversized values. */
function cleanTitle(title: string): string {
  const value = title.replace(/\s+/g, " ").trim()
  if (!value) throw new Error("Unit title is required")
  return value.slice(0, MAX_UNIT_TITLE)
}

/** Loads a unit and confirms it exists. */
async function requireUnit(
  ctx: Pick<QueryCtx, "db">,
  unitId: Id<"units">
): Promise<Doc<"units">> {
  const unit = await ctx.db.get(unitId)
  if (!unit) throw new Error("Unit not found")
  return unit
}

/** Returns the most recently used Teach session for a unit, if any. */
async function latestTeachChat(
  ctx: Pick<QueryCtx, "db">,
  unitId: Id<"units">
): Promise<Doc<"workspaceChats"> | null> {
  return ctx.db
    .query("workspaceChats")
    .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unitId))
    .order("desc")
    .first()
}

/** Summarises a source for lists without its extracted text. */
function sourceSummary(source: Doc<"sources">) {
  return {
    id: source._id,
    filename: source.filename,
    kind: source.kind,
    status: source.status,
    unsupported: source.unsupported ?? false,
    error: source.error ?? null,
    hasText: source.extractedText.trim().length > 0,
    createdAt: source.createdAt,
  }
}

/** Most concept names of each strength passed to the tutor. */
const MAX_KNOWN_CONCEPTS = 25

/**
 * Lists concepts from the module's other units that the learner has answered
 * questions on, split into known well and still shaky, so the tutor can build
 * on them instead of re-teaching them.
 */
async function knownConcepts(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  unitId: Id<"units">
): Promise<{ strong: string[]; shaky: string[] }> {
  const reviews = await ctx.db
    .query("conceptReviews")
    .withIndex("by_project_concept", (q) => q.eq("projectId", projectId))
    .collect()
  const strong: string[] = []
  const shaky: string[] = []
  for (const review of reviews) {
    if (review.attemptCount <= 0) continue
    const concept = await ctx.db.get(review.conceptId)
    if (!concept || concept.unitId === unitId) continue
    const strength = conceptStrength({
      attempts: review.attemptCount,
      correct: review.correctCount,
      consecutiveCorrect: review.consecutiveCorrect,
      ...(review.lastOutcome ? { lastOutcome: review.lastOutcome } : {}),
    })
    if (strength === "strong" && strong.length < MAX_KNOWN_CONCEPTS) strong.push(concept.title)
    else if (strength !== "strong" && shaky.length < MAX_KNOWN_CONCEPTS) shaky.push(concept.title)
  }
  return { strong, shaky }
}

/** Summarises a Teach session's position in its outline. */
function teachSummary(chat: Doc<"workspaceChats"> | null) {
  if (!chat) return null
  const total = chat.teachOutline?.sections.length ?? 0
  const reached = chat.teachSectionIndex ?? (total ? 0 : -1)
  return {
    chatId: chat._id,
    status: chat.status,
    sectionCount: total,
    /** Zero-based section being taught, or -1 before the outline arrives. */
    sectionIndex: reached,
    /** Set once the tutor has sent its end-of-unit recap. */
    completed: total > 0 && reached >= total,
    /** Sections actually taught; a jump can leave earlier ones untaught. */
    taughtSectionIds: chat.teachTaughtSectionIds ?? [],
    /** Sections the pre-check showed the learner already knows. */
    skippedSectionIds: (chat.teachSectionPlan ?? [])
      .filter((entry) => entry.mode === "skip")
      .map((entry) => entry.id),
    /** Section ids in outline order, for drawing one segment per section. */
    sectionIds: chat.teachOutline?.sections.map((section) => section.id) ?? [],
    currentSectionTitle:
      total && reached >= 0 && reached < total
        ? chat.teachOutline!.sections[reached].title
        : null,
    updatedAt: chat.updatedAt,
  }
}

/**
 * Returns how much of a unit has been taught, from 0 to 1, counting sections
 * actually taught so jumping ahead does not inflate it. A finished unit is 1.
 */
function taughtShare(summary: ReturnType<typeof teachSummary>): number {
  if (!summary?.sectionCount) return 0
  if (summary.completed) return 1
  // A section skipped because the learner already knows it counts as covered.
  const covered = new Set([...summary.taughtSectionIds, ...summary.skippedSectionIds])
  return Math.min(1, covered.size / summary.sectionCount)
}

/**
 * Lists a module's units in path order with their sources and Teach progress,
 * plus sources that were imported before units existed. Past papers and their
 * solutions are unit-less module sources too, but they belong to exam prep, so
 * they are left out of the unsorted list.
 */
export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const units = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", projectId))
      .collect()
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect()
    const examSources = new Set<string>()
    const papers = await ctx.db
      .query("examPapers")
      .withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId))
      .collect()
    // Deleted past papers count too: their files stay out of the units after the paper is gone.
    for (const paper of papers)
      for (const id of [paper.sourceId, paper.solutionsSourceId]) if (id) examSources.add(id)
    const byUnit = new Map<string, Doc<"sources">[]>()
    const unsorted: Doc<"sources">[] = []
    const references: Doc<"sources">[] = []
    for (const source of sources) {
      if (source.role === "reference") references.push(source)
      else if (!source.unitId) {
        // Exam papers and their solutions are not taught, so they are not listed here.
        if (!examSources.has(source._id)) unsorted.push(source)
      } else byUnit.set(source.unitId, [...(byUnit.get(source.unitId) ?? []), source])
    }
    const result = await Promise.all(
      units.map(async (unit) => ({
        id: unit._id,
        title: unit.title,
        titleSource: unit.titleSource,
        order: unit.order,
        createdAt: unit.createdAt,
        sources: (byUnit.get(unit._id) ?? [])
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(sourceSummary),
        teach: teachSummary(await latestTeachChat(ctx, unit._id)),
      }))
    )
    return {
      units: result,
      unsortedSources: unsorted
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(sourceSummary),
      /** Whole books and other large sources that back up every unit. */
      referenceSources: references
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(sourceSummary),
    }
  },
})

/** Returns one unit with its sources and Teach progress for the Teach screen. */
export const get = query({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const unit = await ctx.db.get(unitId)
    if (!unit) return null
    const project = await ctx.db.get(unit.projectId)
    if (!project) return null
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect()
    const chat = await latestTeachChat(ctx, unitId)
    const siblings = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", unit.projectId))
      .collect()
    const position = siblings.findIndex((item) => item._id === unitId)
    return {
      id: unit._id,
      projectId: unit.projectId,
      projectTitle: project.title,
      title: unit.title,
      sources: sources
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(sourceSummary),
      teach: teachSummary(chat),
      outline: chat?.teachOutline ?? null,
      plan: chat?.teachSectionPlan ?? null,
      nextUnit:
        position >= 0 && position < siblings.length - 1
          ? { id: siblings[position + 1]._id, title: siblings[position + 1].title }
          : null,
    }
  },
})

/** Creates a unit at the end of the module's learning path. */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    titleSource: v.optional(v.union(v.literal("auto"), v.literal("user"))),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId))) throw new Error("Project not found")
    const last = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .first()
    const now = Date.now()
    return ctx.db.insert("units", {
      projectId: args.projectId,
      title: cleanTitle(args.title),
      titleSource: args.titleSource ?? "user",
      order: (last?.order ?? 0) + 1,
      createdAt: now,
      updatedAt: now,
    })
  },
})

/** Renames a unit; a learner-chosen title is never replaced by the tutor. */
export const rename = mutation({
  args: { unitId: v.id("units"), title: v.string() },
  handler: async (ctx, args) => {
    await requireUnit(ctx, args.unitId)
    await ctx.db.patch(args.unitId, {
      title: cleanTitle(args.title),
      titleSource: "user",
      updatedAt: Date.now(),
    })
  },
})

/** Moves a unit one place earlier or later in the learning path. */
export const move = mutation({
  args: {
    unitId: v.id("units"),
    direction: v.union(v.literal("earlier"), v.literal("later")),
  },
  handler: async (ctx, args) => {
    const unit = await requireUnit(ctx, args.unitId)
    const siblings = await ctx.db
      .query("units")
      .withIndex("by_project_order", (q) => q.eq("projectId", unit.projectId))
      .collect()
    const index = siblings.findIndex((item) => item._id === unit._id)
    const other = siblings[args.direction === "earlier" ? index - 1 : index + 1]
    if (!other) return
    const now = Date.now()
    await ctx.db.patch(unit._id, { order: other.order, updatedAt: now })
    await ctx.db.patch(other._id, { order: unit.order, updatedAt: now })
  },
})

/**
 * Assigns a source to a unit, or back to unsorted when `unitId` is omitted.
 * A reference book moved this way stops being a reference book.
 */
export const moveSource = mutation({
  args: { sourceId: v.id("sources"), unitId: v.optional(v.id("units")) },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source) throw new Error("Source not found")
    if (args.unitId) {
      const unit = await requireUnit(ctx, args.unitId)
      if (unit.projectId !== source.projectId)
        throw new Error("Unit belongs to another project")
    }
    await ctx.db.patch(source._id, { unitId: args.unitId, role: undefined })
  },
})

/**
 * Deletes a unit and archives its Teach sessions. No source is ever deleted:
 * without `moveSourcesTo`, a unit that still has sources is refused; with it,
 * the sources, practice questions, and concepts move to that unit, or out of
 * every unit when it is `null`. Learning history (answers, XP) is kept.
 * @throws When the unit has sources and no destination is given, or the
 * destination is the unit itself or belongs to another module.
 */
export const remove = mutation({
  args: {
    unitId: v.id("units"),
    /** Unit that takes over this unit's material, or `null` to leave it unsorted. */
    moveSourcesTo: v.optional(v.union(v.id("units"), v.null())),
  },
  handler: async (ctx, { unitId, moveSourcesTo }) => {
    const unit = await requireUnit(ctx, unitId)
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect()
    if (sources.length && moveSourcesTo === undefined)
      throw new Error("Move or delete this unit's sources first")
    if (moveSourcesTo) {
      if (moveSourcesTo === unitId) throw new Error("Choose a different unit for this material")
      const target = await requireUnit(ctx, moveSourcesTo)
      if (target.projectId !== unit.projectId) throw new Error("Unit belongs to another project")
    }
    // Unset rather than null: these fields are optional ids.
    const destination = moveSourcesTo ?? undefined
    const now = Date.now()

    for (const source of sources) await ctx.db.patch(source._id, { unitId: destination })
    // Questions and concepts follow the material so drills and weak-concept
    // links never point at a unit that no longer exists.
    const items = await ctx.db
      .query("learningItems")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect()
    for (const item of items) await ctx.db.patch(item._id, { unitId: destination })
    const concepts = await ctx.db
      .query("concepts")
      .withIndex("by_project", (q) => q.eq("projectId", unit.projectId))
      .collect()
    for (const concept of concepts)
      if (concept.unitId === unitId) await ctx.db.patch(concept._id, { unitId: destination })
    if (destination) await ctx.db.patch(destination, { updatedAt: now })

    // Deleting question runs makes an in-flight run's save fail instead of
    // writing questions for a unit that is gone.
    const runs = await ctx.db
      .query("questionGenerations")
      .withIndex("by_unit_startedAt", (q) => q.eq("unitId", unitId))
      .collect()
    for (const run of runs) await ctx.db.delete(run._id)
    const chats = await ctx.db
      .query("workspaceChats")
      .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unitId))
      .collect()
    for (const chat of chats) await ctx.db.patch(chat._id, { isArchived: true })
    await ctx.db.delete(unitId)
  },
})

/**
 * Returns the unit's Teach session, creating it on first use.
 * @returns The chat ID and whether the session already has messages.
 */
export const startTeach = mutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    const unit = await requireUnit(ctx, unitId)
    const existing = await latestTeachChat(ctx, unitId)
    if (existing && !existing.isArchived) {
      const message = await ctx.db
        .query("workspaceChatMessages")
        .withIndex("by_chat_createdAt", (q) => q.eq("chatId", existing._id))
        .first()
      return { chatId: existing._id, started: Boolean(message) }
    }
    const now = Date.now()
    const chatId = await ctx.db.insert("workspaceChats", {
      projectId: unit.projectId,
      purpose: "teach",
      unitId,
      title: `Teach: ${unit.title}`,
      isUnread: false,
      isPinned: false,
      agentAutonomy: "approval",
      status: "idle",
      createdAt: now,
      updatedAt: now,
    })
    return { chatId, started: false }
  },
})

/**
 * Archives a unit's current Teach session so the next visit starts over with a
 * fresh outline. Answered questions and their history are kept.
 */
export const restartTeach = mutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    await requireUnit(ctx, unitId)
    const chats = await ctx.db
      .query("workspaceChats")
      .withIndex("by_unit_updatedAt", (q) => q.eq("unitId", unitId))
      .collect()
    for (const chat of chats) {
      if (chat.status === "running") throw new Error("Wait for the reply to finish")
      // Detach so `latestTeachChat` no longer finds it, keeping it readable in archives.
      await ctx.db.patch(chat._id, { isArchived: true, unitId: undefined })
    }
  },
})

/**
 * Supplies the server with everything a Teach turn needs: the unit, its
 * module, each source's extracted text, and chunk IDs for citations.
 * Server-only: called by the chat route, never by the browser.
 */
export const teachContext = query({
  args: {
    chatId: v.id("workspaceChats"),
    /** The learner's message for this turn, used to pick relevant citable passages. */
    message: v.optional(v.string()),
  },
  handler: async (ctx, { chatId, message }) => {
    const chat = await ctx.db.get(chatId)
    if (!chat || chat.purpose !== "teach" || !chat.unitId) return null
    const unit = await ctx.db.get(chat.unitId)
    if (!unit) return null
    const project = await ctx.db.get(unit.projectId)
    if (!project) return null
    const sources = (
      await ctx.db
        .query("sources")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect()
    ).sort((a, b) => a.createdAt - b.createdAt)
    const focus = teachTurnFocus(
      message ?? "",
      chat.teachOutline,
      chat.teachSectionIndex
    )
    // Every chunk is citable when the unit is small; otherwise the passages
    // closest to this turn's focus win, with document order as the tiebreak.
    const candidates: Array<{ id: Id<"sourceChunks">; score: number; order: number }> = []
    for (const [sourceIndex, source] of sources.entries()) {
      // Document order across the unit: source position, then chunk position.
      const orderOf = (ordinal: number) => sourceIndex * 1_000_000 + ordinal
      const chunks = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source_ordinal", (q) => q.eq("sourceId", source._id))
        .take(MAX_CHUNKS_SCANNED_PER_SOURCE)
      for (const chunk of chunks)
        candidates.push({
          id: chunk._id,
          score: focus
            ? passageScore(
                {
                  text: chunk.text,
                  label: chunk.sectionTitle ?? "",
                  startOffset: chunk.startOffset,
                  endOffset: chunk.endOffset,
                },
                focus
              )
            : 0,
          order: orderOf(chunk.ordinal),
        })
      // Long sources: also search the whole source, so passages past the
      // scanned start can be cited when they match this turn's focus.
      if (focus && chunks.length >= MAX_CHUNKS_SCANNED_PER_SOURCE) {
        const terms = searchTerms(focus)
        if (terms) {
          const matches = await ctx.db
            .query("sourceChunks")
            .withSearchIndex("search_text", (q) =>
              q.search("text", terms).eq("projectId", unit.projectId).eq("sourceId", source._id)
            )
            .take(8)
          for (const match of matches)
            if (!candidates.some((candidate) => candidate.id === match._id))
              candidates.push({ id: match._id, score: 100, order: orderOf(match.ordinal) })
        }
      }
    }
    // Reference books for the module are searched for this turn's topic.
    const references = await ctx.db
      .query("sources")
      .withIndex("by_project_role", (q) =>
        q.eq("projectId", unit.projectId).eq("role", "reference")
      )
      .collect()
    // The unit's topic anchors every search so a section title's common words
    // do not pull in unrelated chapters.
    const topic = chat.teachOutline?.title ?? unit.title
    const terms = searchTerms(
      focus
        ? `${topic} ${topic} ${focus}`
        : [topic, ...sources.map((source) => source.extractedText.slice(0, 3_000))].join(" ")
    )
    const referenceExcerpts: Array<{ chunkId: Id<"sourceChunks">; filename: string; text: string }> = []
    if (terms && references.length) {
      const perReference = Math.max(1, Math.floor(MAX_REFERENCE_EXCERPTS / references.length))
      for (const reference of references) {
        const matches = await ctx.db
          .query("sourceChunks")
          .withSearchIndex("search_text", (q) =>
            q.search("text", terms).eq("projectId", unit.projectId).eq("sourceId", reference._id)
          )
          .take(perReference)
        for (const match of matches)
          referenceExcerpts.push({
            chunkId: match._id,
            filename: reference.filename,
            text: match.text.slice(0, MAX_REFERENCE_EXCERPT_TEXT),
          })
      }
    }
    const chunkIds = [
      ...candidates
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, MAX_TEACH_CITATION_CHUNKS - referenceExcerpts.length)
        .sort((a, b) => a.order - b.order)
        .map((candidate) => candidate.id),
      ...referenceExcerpts.map((excerpt) => excerpt.chunkId),
    ]
    return {
      projectId: project._id,
      moduleTitle: project.title,
      unitId: unit._id,
      unitTitle: unit.title,
      unitTitleSource: unit.titleSource,
      outline: chat.teachOutline ?? null,
      sectionIndex: chat.teachSectionIndex ?? null,
      plan: chat.teachSectionPlan ?? null,
      knownConcepts: await knownConcepts(ctx, unit.projectId, unit._id),
      sources: sources
        .filter((source) => source.extractedText.trim())
        .map((source) => ({
          id: source._id,
          filename: source.filename,
          ...(source.relativeKey ? { relativeKey: source.relativeKey } : {}),
          text: source.extractedText.slice(0, MAX_TEACH_SOURCE_TEXT),
          truncated: source.extractedText.length > MAX_TEACH_SOURCE_TEXT,
        })),
      citationChunkIds: chunkIds,
      /**
       * What this turn teaches, for ranking citable passages. A quick reply
       * such as `Next section` says nothing about the passages it needs.
       */
      citationFocus: focus ?? null,
      referenceExcerpts: referenceExcerpts.map(({ filename, text }) => ({ filename, text })),
    }
  },
})

/**
 * Records outline progress parsed from a finished Teach reply. The first
 * outline is kept; later outlines are ignored so section ids stay stable.
 * Progress only moves forward, and an `auto` unit title takes the tutor's
 * topic title.
 */
export const recordTeachProgress = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    outline: v.optional(teachOutlineFields),
    /** The skip, skim, or teach plan from the reply after the pre-check. */
    plan: v.optional(teachSectionPlanFields),
    /** Section id that the reply taught, or `done` after the recap. */
    sectionId: v.optional(v.string()),
    /** Replacement title for an `auto` unit, derived from the outline. */
    unitTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    if (!chat || chat.purpose !== "teach" || !chat.unitId)
      throw new Error("Teach session not found")
    const outline = chat.teachOutline ?? args.outline
    if (!outline) return
    if (outline.sections.length > 12 || !outline.sections.length)
      throw new Error("Outline is invalid")
    // The index is the section being taught now (a jump moves it anywhere);
    // `taught` records which sections were actually taught.
    let index = chat.teachSectionIndex ?? 0
    const taught = new Set(chat.teachTaughtSectionIds ?? [])
    let newlyTaught: string | undefined
    if (args.sectionId === "done") index = outline.sections.length
    else if (args.sectionId) {
      const found = outline.sections.findIndex(
        (section) => section.id === args.sectionId
      )
      if (found >= 0) {
        index = found
        if (!taught.has(args.sectionId)) newlyTaught = args.sectionId
        taught.add(args.sectionId)
      }
    }
    // Only the first plan counts, and only when it covers this outline.
    const plan =
      chat.teachSectionPlan ??
      (args.plan &&
      args.plan.length === outline.sections.length &&
      args.plan.every((entry, position) => entry.id === outline.sections[position].id)
        ? args.plan
        : undefined)
    await ctx.db.patch(chat._id, {
      teachOutline: outline,
      teachSectionIndex: index,
      teachTaughtSectionIds: [...taught],
      ...(plan ? { teachSectionPlan: plan } : {}),
    })
    const startedUnit = await ctx.db.get(chat.unitId)
    if (startedUnit && !startedUnit.startedAt)
      await ctx.db.patch(startedUnit._id, { startedAt: Date.now() })
    // Milestones feed XP and streaks. Only sections actually taught count,
    // each once per unit, even if the unit is restarted.
    const now = Date.now()
    const logged = await ctx.db
      .query("learningActivity")
      .withIndex("by_unit_kind", (q) => q.eq("unitId", chat.unitId!))
      .collect()
    if (
      newlyTaught &&
      !logged.some((entry) => entry.kind === "section" && entry.sectionId === newlyTaught)
    )
      await ctx.db.insert("learningActivity", {
        kind: "section",
        projectId: chat.projectId!,
        unitId: chat.unitId,
        sectionId: newlyTaught,
        occurredAt: now,
      })
    if (index >= outline.sections.length && !logged.some((entry) => entry.kind === "unit"))
      await ctx.db.insert("learningActivity", {
        kind: "unit",
        projectId: chat.projectId!,
        unitId: chat.unitId,
        occurredAt: now,
      })
    const unit = await ctx.db.get(chat.unitId)
    if (unit && unit.titleSource === "auto" && args.unitTitle && !chat.teachOutline)
      await ctx.db.patch(unit._id, {
        title: cleanTitle(args.unitTitle),
        updatedAt: Date.now(),
      })
  },
})

/**
 * Summarises every module for the Library: how many units are fully taught,
 * which unit comes next, and when the learner last studied it. Reads unit and
 * Teach session records, never whole source lists, so it stays cheap. A module
 * with no units gets an entry only when it has taught material outside a unit,
 * found by reading its sources until the first one that is not an exam paper
 * or a reference book (usually the first). Also counts each module's concepts
 * due for review at `now`, using the same rule as the Today panel.
 * @param now Client clock rounded to the minute, so due counts roll over as time passes.
 *   Callers without a client clock (server and CLI reads) omit it and get the server time.
 */
export const libraryProgress = query({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const units = await ctx.db.query("units").collect()
    const byProject = new Map<
      string,
      {
        unitCount: number
        taughtCount: number
        nextUnitTitle: string | null
        lastStudiedAt: number
        /** True when a module without units already has sources to group. */
        hasUnsortedSources: boolean
        /** Share of each unit's sections taught (0 to 1), in path order. */
        unitProgress: number[]
        /** Concepts taught in a unit that are due for review at `now`. */
        dueCount: number
      }
    >()
    const ordered = [...units].sort((a, b) => a.order - b.order)
    for (const unit of ordered) {
      const key = String(unit.projectId)
      const entry = byProject.get(key) ?? {
        unitCount: 0,
        taughtCount: 0,
        nextUnitTitle: null,
        lastStudiedAt: 0,
        hasUnsortedSources: false,
        unitProgress: [],
        dueCount: 0,
      }
      entry.unitCount += 1
      const chat = await latestTeachChat(ctx, unit._id)
      const summary = teachSummary(chat)
      entry.unitProgress.push(taughtShare(summary))
      if (summary?.completed) entry.taughtCount += 1
      else if (!entry.nextUnitTitle) entry.nextUnitTitle = unit.title
      entry.lastStudiedAt = Math.max(
        entry.lastStudiedAt,
        chat?.updatedAt ?? 0,
        unit.startedAt ?? 0
      )
      byProject.set(key, entry)
    }
    const projects = await ctx.db.query("projects").collect()
    // Only modules with units can have due concepts, so only their entries are counted.
    // Each module reads its own due index range, never every review in the database.
    for (const project of projects) {
      const entry = byProject.get(String(project._id))
      if (!entry) continue
      for await (const review of ctx.db
        .query("conceptReviews")
        .withIndex("by_project_dueAt", (q) =>
          q.eq("projectId", project._id).lte("dueAt", now)
        )) {
        if (review.attemptCount <= 0) continue
        const concept = await ctx.db.get(review.conceptId)
        if (concept?.unitId) entry.dueCount += 1
      }
    }
    for (const project of projects) {
      if (byProject.has(String(project._id))) continue
      const examSources = new Set<string>()
      for (const paper of await ctx.db
        .query("examPapers")
        .withIndex("by_project_createdAt", (q) => q.eq("projectId", project._id))
        .collect())
        for (const id of [paper.sourceId, paper.solutionsSourceId]) if (id) examSources.add(id)
      for await (const source of ctx.db
        .query("sources")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))) {
        if (source.role === "reference" || examSources.has(source._id)) continue
        byProject.set(String(project._id), {
          unitCount: 0,
          taughtCount: 0,
          nextUnitTitle: null,
          lastStudiedAt: 0,
          hasUnsortedSources: true,
          unitProgress: [],
          dueCount: 0,
        })
        break
      }
    }
    return Object.fromEntries(byProject)
  },
})
