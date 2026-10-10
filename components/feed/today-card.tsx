"use client"

/**
 * The first page of Home: the streak, today's XP against the daily goal, the
 * last seven days, and one action to continue learning. Study cards follow it
 * in the feed.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ArrowRightIcon, ZapIcon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"

/** Formats a `YYYY-MM-DD` key as a short weekday label. */
function weekday(day: string, style: "narrow" | "long"): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    weekday: style,
    timeZone: "UTC",
  })
}

/** Renders the Today page at the top of the home feed. */
export function TodayCard() {
  // Days follow the learner's local midnight.
  const [tzOffsetMinutes] = useState(() => new Date().getTimezoneOffset())
  const summary = useQuery(api.progress.today, { tzOffsetMinutes })

  return (
    <section
      aria-label="Today"
      className="feed-card flex h-svh snap-start items-center px-4 pt-24 pb-10 sm:px-8 sm:pt-20 sm:pb-8"
    >
      <div className="mx-auto w-full max-w-[680px]">
        {summary === undefined ? (
          <div className="space-y-4" aria-label="Loading today">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{weekday(summary.today, "long")}</p>
            <h1 className="mt-1 flex items-center gap-3 text-[clamp(2rem,7vw,3.25rem)] leading-none font-medium tracking-[-0.045em]">
              <ZapIcon
                aria-hidden="true"
                className={cn("size-[0.8em] shrink-0", summary.streak.current ? "text-brand" : "text-muted-foreground")}
              />
              {summary.streak.current
                ? `${summary.streak.current}-day streak`
                : "Start a streak today"}
            </h1>

            <div className="mt-8">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="font-medium">Today</span>
                <span className="tabular-nums text-muted-foreground">
                  {summary.todayXp} / {summary.goal} XP
                </span>
              </div>
              <Progress
                value={Math.min(100, (summary.todayXp / summary.goal) * 100)}
                aria-label={`${summary.todayXp} of ${summary.goal} XP today`}
                className="mt-2 h-2 [&_[data-slot=progress-indicator]]:bg-brand"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {summary.streak.todayMet
                  ? "Daily goal met. Anything more is extra."
                  : `${summary.goal - summary.todayXp} XP to keep your streak. A taught section is 25 XP, a correct answer 10.`}
              </p>
            </div>

            <WeekChart week={summary.week} goal={summary.goal} />

            <div className="mt-8 flex flex-col gap-3">
              {summary.resume ? (
                <Button
                  asChild
                  className="h-auto min-h-12 w-full justify-between rounded-2xl bg-brand px-5 py-3 text-left text-brand-foreground hover:bg-brand/85 sm:w-auto sm:min-w-[24rem]"
                >
                  <Link
                    href={`/projects/${encodeURIComponent(summary.resume.projectId)}/learn/${encodeURIComponent(summary.resume.unitId)}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">Continue {summary.resume.unitTitle}</span>
                      <span className="block truncate text-xs opacity-80">{summary.resume.detail}</span>
                    </span>
                    <ArrowRightIcon aria-hidden="true" className="shrink-0" />
                  </Link>
                </Button>
              ) : (
                <Button
                  asChild
                  className="min-h-12 w-full rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85 sm:w-auto"
                >
                  <Link href="/library">Pick a module to learn</Link>
                </Button>
              )}
              <p className="text-sm text-muted-foreground">
                {summary.dueConcepts
                  ? `${summary.dueConcepts} concept${summary.dueConcepts === 1 ? " is" : "s are"} due for review. Scroll down to review.`
                  : "Scroll down for questions on what you've studied."}
              </p>
            </div>
          </>
        )}
      </div>
    </section>
  )
}

/** Seven bars showing XP per day; days that met the goal are filled. */
function WeekChart({ week, goal }: { week: Array<{ day: string; xp: number }>; goal: number }) {
  const ceiling = Math.max(goal, ...week.map((entry) => entry.xp))
  return (
    <ol aria-label="XP over the last seven days" className="mt-8 grid h-24 grid-cols-7 items-end gap-2">
      {week.map((entry, index) => {
        const met = entry.xp >= goal
        const isToday = index === week.length - 1
        return (
          <li key={entry.day} className="flex h-full flex-col items-center justify-end gap-1.5">
            <span className="sr-only">
              {weekday(entry.day, "long")}: {entry.xp} XP{met ? ", goal met" : ""}
            </span>
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
