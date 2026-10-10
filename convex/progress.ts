/**
 * Supplies Home's habit summary: today's XP against the daily goal, the
 * streak, the last seven days, what to continue, and how much is waiting to
 * be reviewed. XP comes from answered questions and Teach milestones.
 */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import { conceptStrength } from "../lib/drill"
import {
  computeStreak,
  DAILY_GOAL_RANGE,
  DEFAULT_DAILY_GOAL_XP,
  DEFAULT_REMINDER_HOUR,
  localDayKey,
  previousDayKey,
  summarizeSession,
  XP,
} from "../lib/progress"

/** Days of history read to compute the streak. */
const HISTORY_DAYS = 120

/** Recent chats inspected to find the Teach session to continue. */
const RECENT_CHATS = 60

/** Returns the saved study preferences, filling in defaults. */
async function preferences(ctx: Pick<QueryCtx, "db">) {
  const saved = await ctx.db
    .query("studyPreferences")
    .withIndex("by_scope", (q) => q.eq("scope", "global"))
    .unique()
  return {
    goal: saved?.dailyGoalXp ?? DEFAULT_DAILY_GOAL_XP,
    reminderHour:
      saved?.reminderHour === undefined ? DEFAULT_REMINDER_HOUR : saved.reminderHour,
  }
}

/**
 * Reads the answers and Teach milestones from the streak window and totals
 * XP per local day.
 * @param tzOffsetMinutes The browser's `Date#getTimezoneOffset()`, clamped to real offsets.
 * @param now Client clock.
 */
async function studyHistory(ctx: Pick<QueryCtx, "db">, tzOffsetMinutes: number, now: number) {
  const offset = Math.max(-840, Math.min(840, Math.round(tzOffsetMinutes)))
  const since = now - HISTORY_DAYS * 86_400_000
  const xpByDay = new Map<string, number>()
  /** Adds XP to the local day of a timestamp. */
  const add = (timestamp: number, amount: number) => {
    const day = localDayKey(timestamp, offset)
    xpByDay.set(day, (xpByDay.get(day) ?? 0) + amount)
  }
  const answers = await ctx.db
    .query("studyEvents")
    .withIndex("by_eventType_occurredAt", (q) =>
      q.eq("eventType", "answer").gte("occurredAt", since)
    )
    .collect()
  for (const answer of answers)
    add(answer.occurredAt, answer.outcome === "correct" ? XP.correctAnswer : XP.incorrectAnswer)
  const milestones = await ctx.db
    .query("learningActivity")
    .withIndex("by_occurredAt", (q) => q.gte("occurredAt", since))
    .collect()
  for (const milestone of milestones)
    add(milestone.occurredAt, milestone.kind === "unit" ? XP.unit : XP.section)
  return { offset, xpByDay, answers, milestones }
}

/**
 * Returns Home's summary for the learner's local day.
 * @param tzOffsetMinutes The browser's `Date#getTimezoneOffset()`, so days follow local midnight.
 */
export const today = query({
  args: {
    tzOffsetMinutes: v.number(),
    /** Client clock rounded to the minute, so the day rolls over at local midnight. */
    now: v.number(),
  },
  handler: async (ctx, { tzOffsetMinutes, now }) => {
    const { offset, xpByDay, answers, milestones } = await studyHistory(ctx, tzOffsetMinutes, now)
    const todayKey = localDayKey(now, offset)
    let answeredToday = 0
    for (const answer of answers)
      if (localDayKey(answer.occurredAt, offset) === todayKey) answeredToday += 1
    let sectionsToday = 0
    for (const milestone of milestones)
      if (milestone.kind === "section" && localDayKey(milestone.occurredAt, offset) === todayKey)
        sectionsToday += 1
    const { goal, reminderHour } = await preferences(ctx)
    const streak = computeStreak(xpByDay, todayKey, goal)
    const week = Array.from({ length: 7 }, (_, index) => {
      const day = previousDayKey(todayKey, 6 - index)
      return { day, xp: xpByDay.get(day) ?? 0 }
    })

    // The most recently used Teach session that still has sections to go.
    const chats = await ctx.db
      .query("workspaceChats")
      .withIndex("by_updatedAt")
      .order("desc")
      .take(RECENT_CHATS)
    let resume: {
      projectId: string
      projectTitle: string
      unitId: string
      unitTitle: string
      detail: string
      /** Sections in the unit's outline; 0 before the outline arrives. */
      sectionCount: number
      /** Zero-based section being taught. */
      sectionIndex: number
      /** Ids of sections actually taught, for the segmented bar. */
      taughtSectionIds: string[]
      /** Section ids in outline order. */
      sectionIds: string[]
    } | null = null
    for (const chat of chats) {
      if (chat.purpose !== "teach" || !chat.unitId || chat.isArchived || !chat.projectId) continue
      const total = chat.teachOutline?.sections.length ?? 0
      const index = chat.teachSectionIndex ?? 0
      if (total && index >= total) continue
      const unit = await ctx.db.get(chat.unitId)
      const project = await ctx.db.get(chat.projectId)
      if (!unit || !project) continue
      resume = {
        projectId: project._id,
        projectTitle: project.title,
        unitId: unit._id,
        unitTitle: unit.title,
        detail: total
          ? `Section ${index + 1} of ${total}: ${chat.teachOutline!.sections[index].title}`
          : "Started",
        sectionCount: total,
        sectionIndex: index,
        taughtSectionIds: chat.teachTaughtSectionIds ?? [],
        sectionIds: chat.teachOutline?.sections.map((section) => section.id) ?? [],
      }
      break
    }

    // Only concepts from units count; older generated lessons are not part of Teach.
    const reviews = await ctx.db.query("conceptReviews").collect()
    let dueConcepts = 0
    for (const review of reviews) {
      if (review.attemptCount <= 0 || review.dueAt > now) continue
      const concept = await ctx.db.get(review.conceptId)
      if (concept?.unitId) dueConcepts += 1
    }

    return {
      today: todayKey,
      todayXp: xpByDay.get(todayKey) ?? 0,
      goal,
      streak,
      week,
      answeredToday,
      sectionsToday,
      resume,
      dueConcepts,
      reminderHour,
    }
  },
})

/** Saves the daily XP goal, bounded to a sensible range. */
export const setDailyGoal = mutation({
  args: { xp: v.number() },
  handler: async (ctx, { xp }) => {
    const value = Math.round(xp)
    if (!Number.isFinite(value) || value < DAILY_GOAL_RANGE.min || value > DAILY_GOAL_RANGE.max)
      throw new Error(`Choose a goal between ${DAILY_GOAL_RANGE.min} and ${DAILY_GOAL_RANGE.max} XP`)
    const existing = await ctx.db
      .query("studyPreferences")
      .withIndex("by_scope", (q) => q.eq("scope", "global"))
      .unique()
    if (existing) await ctx.db.patch(existing._id, { dailyGoalXp: value, updatedAt: Date.now() })
    else
      await ctx.db.insert("studyPreferences", {
        scope: "global",
        dailyGoalXp: value,
        updatedAt: Date.now(),
      })
  },
})

/** Returns the saved daily goal and reminder hour for Settings. */
export const dailyGoalSetting = query({
  args: {},
  handler: async (ctx) => {
    const { goal, reminderHour } = await preferences(ctx)
    return { xp: goal, reminderHour }
  },
})

/** Saves the desktop reminder hour (0–23), or turns reminders off with null. */
export const setReminderHour = mutation({
  args: { hour: v.union(v.number(), v.null()) },
  handler: async (ctx, { hour }) => {
    if (hour !== null && (!Number.isInteger(hour) || hour < 0 || hour > 23))
      throw new Error("Choose an hour between 0 and 23")
    const existing = await ctx.db
      .query("studyPreferences")
      .withIndex("by_scope", (q) => q.eq("scope", "global"))
      .unique()
    if (existing)
      await ctx.db.patch(existing._id, { reminderHour: hour, updatedAt: Date.now() })
    else
      await ctx.db.insert("studyPreferences", {
        scope: "global",
        dailyGoalXp: DEFAULT_DAILY_GOAL_XP,
        reminderHour: hour,
        updatedAt: Date.now(),
      })
  },
})

/**
 * Longest session a module-wide summary covers; older starts are clamped to
 * this, because those summaries scan every project's events by time. Unit
 * summaries read by concept and unit instead, so they cover the whole unit
 * however many days it took.
 */
const MAX_SESSION_MS = 12 * 60 * 60 * 1000

/**
 * Summarises one study session for its end screen: answers, XP, Teach
 * sections, how each concept went and how strong it is now, and where today's
 * goal and streak stand.
 * @param since When the session started; answers and milestones from then on count.
 * @param projectId Module the session belongs to.
 * @param unitId When set, only that unit's concepts and milestones count.
 */
export const sessionSummary = query({
  args: {
    projectId: v.id("projects"),
    unitId: v.optional(v.id("units")),
    since: v.number(),
    tzOffsetMinutes: v.number(),
    now: v.number(),
  },
  handler: async (ctx, { projectId, unitId, since, tzOffsetMinutes, now }) => {
    const start = unitId ? since : Math.max(since, now - MAX_SESSION_MS)
    const { offset, xpByDay } = await studyHistory(ctx, tzOffsetMinutes, now)
    const events = unitId
      ? (
          await Promise.all(
            (
              await ctx.db
                .query("concepts")
                .withIndex("by_project", (q) => q.eq("projectId", projectId))
                .collect()
            )
              .filter((concept) => concept.unitId === unitId)
              .map((concept) =>
                ctx.db
                  .query("studyEvents")
                  .withIndex("by_project_concept_occurredAt", (q) =>
                    q
                      .eq("projectId", projectId)
                      .eq("conceptId", concept._id)
                      .gte("occurredAt", start)
                  )
                  .collect()
              )
          )
        )
          .flat()
          .filter((event) => event.eventType === "answer")
      : await ctx.db
          .query("studyEvents")
          .withIndex("by_eventType_occurredAt", (q) =>
            q.eq("eventType", "answer").gte("occurredAt", start)
          )
          .collect()
    const concepts = new Map<string, { title: string; unitId?: string } | null>()
    const answers = []
    for (const event of events) {
      if (event.projectId !== projectId || !event.outcome) continue
      const key = String(event.conceptId)
      if (!concepts.has(key)) {
        const concept = await ctx.db.get(event.conceptId)
        concepts.set(
          key,
          concept ? { title: concept.title, unitId: concept.unitId && String(concept.unitId) } : null
        )
      }
      const concept = concepts.get(key)
      if (!concept || (unitId && concept.unitId !== String(unitId))) continue
      answers.push({ conceptId: key, correct: event.outcome === "correct" })
    }
    const milestones = unitId
      ? (
          await ctx.db
            .query("learningActivity")
            .withIndex("by_unit_kind", (q) => q.eq("unitId", unitId))
            .collect()
        ).filter((milestone) => milestone.occurredAt >= start)
      : (
          await ctx.db
            .query("learningActivity")
            .withIndex("by_occurredAt", (q) => q.gte("occurredAt", start))
            .collect()
        ).filter((milestone) => milestone.projectId === projectId)
    const totals = summarizeSession(answers, milestones)
    const reviews = await ctx.db
      .query("conceptReviews")
      .withIndex("by_project_dueAt", (q) => q.eq("projectId", projectId))
      .collect()
    const reviewByConcept = new Map(reviews.map((review) => [String(review.conceptId), review]))
    const { goal } = await preferences(ctx)
    const todayKey = localDayKey(now, offset)
    const streak = computeStreak(xpByDay, todayKey, goal)
    return {
      ...totals,
      concepts: totals.concepts.slice(0, 8).map((tally) => {
        const review = reviewByConcept.get(tally.conceptId)
        return {
          ...tally,
          title: concepts.get(tally.conceptId)?.title ?? "",
          strength: conceptStrength({
            attempts: review?.attemptCount ?? 0,
            correct: review?.correctCount ?? 0,
            consecutiveCorrect: review?.consecutiveCorrect ?? 0,
            ...(review?.lastOutcome ? { lastOutcome: review.lastOutcome } : {}),
          }),
        }
      }),
      today: { xp: xpByDay.get(todayKey) ?? 0, goal, streak },
    }
  },
})
