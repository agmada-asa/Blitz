/**
 * Supplies Home's habit summary: today's XP against the daily goal, the
 * streak, the last seven days, what to continue, and how much is waiting to
 * be reviewed. XP comes from answered questions and Teach milestones.
 */

import { v } from "convex/values"

import { mutation, query, type QueryCtx } from "./_generated/server"
import {
  computeStreak,
  DAILY_GOAL_RANGE,
  DEFAULT_DAILY_GOAL_XP,
  DEFAULT_REMINDER_HOUR,
  localDayKey,
  previousDayKey,
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
    let answeredToday = 0
    const todayKey = localDayKey(now, offset)
    for (const answer of answers) {
      add(answer.occurredAt, answer.outcome === "correct" ? XP.correctAnswer : XP.incorrectAnswer)
      if (localDayKey(answer.occurredAt, offset) === todayKey) answeredToday += 1
    }
    const milestones = await ctx.db
      .query("learningActivity")
      .withIndex("by_occurredAt", (q) => q.gte("occurredAt", since))
      .collect()
    let sectionsToday = 0
    for (const milestone of milestones) {
      add(milestone.occurredAt, milestone.kind === "unit" ? XP.unit : XP.section)
      if (milestone.kind === "section" && localDayKey(milestone.occurredAt, offset) === todayKey)
        sectionsToday += 1
    }
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
