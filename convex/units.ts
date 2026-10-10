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
    currentSectionTitle:
      total && reached >= 0 && reached < total
        ? chat.teachOutline!.sections[reached].title
        : null,
    updatedAt: chat.updatedAt,
  }
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

/** Assigns a source to a unit, or back to unsorted when `unitId` is omitted. */
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
    await ctx.db.patch(source._id, { unitId: args.unitId })
  },
})

/**
 * Deletes an empty unit and its Teach sessions' link to it. Units that still
 * have sources must have them moved first, so no source silently disappears.
 */
export const remove = mutation({
  args: { unitId: v.id("units") },
  handler: async (ctx, { unitId }) => {
    await requireUnit(ctx, unitId)
    const source = await ctx.db
      .query("sources")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .first()
    if (source) throw new Error("Move or delete this unit's sources first")
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
    outline: v.optional(
      v.object({
        title: v.string(),
        sections: v.array(v.object({ id: v.string(), title: v.string() })),
      })
    ),
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
    await ctx.db.patch(chat._id, {
      teachOutline: outline,
      teachSectionIndex: index,
      teachTaughtSectionIds: [...taught],
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
 * or a reference book (usually the first).
 */
export const libraryProgress = query({
  args: {},
  handler: async (ctx) => {
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
      }
      entry.unitCount += 1
      const chat = await latestTeachChat(ctx, unit._id)
      const summary = teachSummary(chat)
      if (summary?.completed) entry.taughtCount += 1
      else if (!entry.nextUnitTitle) entry.nextUnitTitle = unit.title
      entry.lastStudiedAt = Math.max(
        entry.lastStudiedAt,
        chat?.updatedAt ?? 0,
        unit.startedAt ?? 0
      )
      byProject.set(key, entry)
    }
    for (const project of await ctx.db.query("projects").collect()) {
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
        })
        break
      }
    }
    return Object.fromEntries(byProject)
  },
})
