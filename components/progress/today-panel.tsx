"use client"

/**
 * Today's study summary: the streak, today's XP against the daily goal, the
 * last seven days, and the two ways to continue: resume the last Teach
 * session or review what is due. It sits above the Library, which is the
 * start page; the XP chip also rides over the Review feed.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import { useEffect, useState } from "react"

import { SegmentedBar, pathSegments } from "@/components/progress/progress-path"
import { ArrowRightIcon, SnowflakeIcon, ZapIcon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { streakMessage } from "@/lib/progress"
import { cn } from "@/lib/utils"

/** Set once a Today panel has shown today's goal as met in this page session, so the streak bolt glows only the first time. */
let goalMetSeen = false

/** Formats a `YYYY-MM-DD` key as a short weekday label. */
function weekday(day: string, style: "narrow" | "long"): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: style,
    timeZone: "UTC",
  })
}

/**
 * Renders the Today panel above the Library. Renders nothing for a learner who
 * has not studied yet, so a fresh install opens straight onto project creation.
 */
export function TodayPanel() {
  // Days follow the learner's local midnight.
  const [tzOffsetMinutes] = useState(() => new Date().getTimezoneOffset())
  const now = useMinuteClock()
  const summary = useQuery(api.progress.today, { tzOffsetMinutes, now })
  // Decided once per mount. The glow class then stays on while the goal is met, so it plays once and never restarts.
  const [glowArmed] = useState(() => !goalMetSeen)
  const goalMet = summary?.streak.todayMet ?? false
  useEffect(() => {
    if (goalMet) goalMetSeen = true
  }, [goalMet])

  if (summary === undefined)
    return (
      <div className="mb-10 space-y-3" aria-label="Loading today">
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )

  const studied = summary.week.some((entry) => entry.xp > 0) || summary.streak.current > 0
  if (!summary.resume && !summary.dueConcepts && !studied) return null

  const resume = summary.resume
  const resumeTaught = new Set(resume?.taughtSectionIds ?? [])

  return (
    <section aria-label="Today" className="mb-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{weekday(summary.today, "long")}</p>
          <h2 className="mt-1 flex items-center gap-2.5 text-2xl font-medium tracking-[-0.04em]">
            <ZapIcon
              aria-hidden="true"
              className={cn(
                "size-[0.8em] shrink-0",
                summary.streak.current ? "text-brand" : "text-muted-foreground",
                glowArmed && goalMet && "goal-met-glow"
              )}
            />
            {summary.streak.current ? `${summary.streak.current}-day streak` : "Start a streak today"}
          </h2>
        </div>
        <p className="flex items-center gap-3 text-sm tabular-nums text-muted-foreground">
          {summary.streak.freezes ? (
            <span className="flex items-center gap-1" title="A freeze covers a day you miss">
              <SnowflakeIcon aria-hidden="true" className="size-3.5" />
              {summary.streak.freezes} {summary.streak.freezes === 1 ? "freeze" : "freezes"}
            </span>
          ) : null}
          <span>
            {summary.todayXp} / {summary.goal} XP
          </span>
        </p>
      </div>
      <Progress
        value={Math.min(100, (summary.todayXp / summary.goal) * 100)}
        aria-label={`${summary.todayXp} of ${summary.goal} XP today`}
        className="mt-3 h-2 [&_[data-slot=progress-indicator]]:bg-brand"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {streakMessage(summary.streak, summary.todayXp, summary.goal)}
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] md:items-end">
        <div className="flex flex-col gap-3">
          {resume ? (
            <Link
              href={`/projects/${encodeURIComponent(resume.projectId)}/learn/${encodeURIComponent(resume.unitId)}`}
              className="group flex items-center gap-4 rounded-2xl border border-brand/25 bg-brand/[0.05] px-5 py-4 transition-colors hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-brand">
                  Continue {resume.projectTitle}
                </span>
                <span className="mt-0.5 block truncate font-medium">{resume.unitTitle}</span>
                <span className="block truncate text-xs text-muted-foreground">{resume.detail}</span>
                <SegmentedBar
                  className="mt-3"
                  segments={pathSegments(
                    resume.sectionIds.map((id, index) => ({
                      key: id,
                      state:
                        index === resume.sectionIndex ? "current" : resumeTaught.has(id) ? "done" : "ahead",
                    }))
                  )}
                />
              </span>
              <span
                aria-hidden="true"
                className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              >
                <ArrowRightIcon className="size-5" />
              </span>
            </Link>
          ) : null}
          {summary.dueConcepts ? (
            <Link
              href="/review"
              className="group flex items-center gap-4 rounded-2xl border border-border bg-card px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  Review {summary.review.count} {summary.review.count === 1 ? "question" : "questions"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  About {summary.review.minutes} min
                  {summary.review.waiting ? ` · ${summary.review.waiting} more due after this` : ""}
                </span>
              </span>
              <ArrowRightIcon
                aria-hidden="true"
                className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              />
            </Link>
          ) : studied ? (
            <Link
              href="/review"
              className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Review what you&apos;ve studied
            </Link>
          ) : null}
        </div>
        <WeekChart
          week={summary.week}
          goal={summary.goal}
          frozenDays={summary.streak.frozenDays}
        />
      </div>
    </section>
  )
}

/**
 * Today's XP against the daily goal as a small chip, shown over the Review
 * feed so the goal stays in view while scrolling, like the session XP chip in Teach.
 * Renders nothing while loading.
 */
export function TodayXpChip() {
  const [tzOffsetMinutes] = useState(() => new Date().getTimezoneOffset())
  const now = useMinuteClock()
  const summary = useQuery(api.progress.today, { tzOffsetMinutes, now })
  if (!summary) return null
  const met = summary.todayXp >= summary.goal
  return (
    <p
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm tabular-nums backdrop-blur-md",
        met
          ? "border-brand/30 bg-brand/10 text-brand"
          : "border-border/80 bg-background/80 text-muted-foreground"
      )}
    >
      <ZapIcon aria-hidden="true" className="size-4" />
      <span>
        {summary.todayXp}
        <span className="sr-only sm:not-sr-only"> / {summary.goal}</span> XP
      </span>
      <span className="sr-only">{met ? "today, daily goal met" : `today of a ${summary.goal} XP goal`}</span>
    </p>
  )
}

/**
 * Seven bars showing XP per day; days that met the goal are filled, and a day
 * a streak freeze covered shows a snowflake.
 */
function WeekChart({
  week,
  goal,
  frozenDays,
}: {
  week: Array<{ day: string; xp: number }>
  goal: number
  frozenDays: string[]
}) {
  const ceiling = Math.max(goal, ...week.map((entry) => entry.xp))
  return (
    <ol aria-label="XP over the last seven days" className="grid h-20 grid-cols-7 items-end gap-2">
      {week.map((entry, index) => {
        const met = entry.xp >= goal
        const isToday = index === week.length - 1
        const frozen = frozenDays.includes(entry.day)
        return (
          <li key={entry.day} className="flex h-full flex-col items-center justify-end gap-1.5">
            <span className="sr-only">
              {weekday(entry.day, "long")}: {entry.xp} XP{met ? ", goal met" : ""}
              {frozen ? ", covered by a streak freeze" : ""}
            </span>
            {frozen ? (
              <SnowflakeIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "w-full max-w-8 rounded-md",
                met ? "bg-brand" : entry.xp ? "bg-brand/35" : "bg-muted",
                isToday && "ring-2 ring-brand/40 ring-offset-2 ring-offset-background"
              )}
              style={{ height: `${Math.max(6, (entry.xp / ceiling) * 100)}%` }}
            />
            <span aria-hidden="true" className={cn("text-[11px] text-muted-foreground", isToday && "font-medium text-foreground")}>
              {weekday(entry.day, "narrow")}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
