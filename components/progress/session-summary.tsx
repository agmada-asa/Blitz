"use client"

/**
 * The end-of-session screen shared by drills and Teach: what the session
 * added up to (XP, questions, sections, time), how each concept went and how
 * strong it is now, and where today's goal and streak stand. Callers supply
 * the heading and the next actions.
 */

import { useQuery } from "convex/react"
import type { ReactNode } from "react"

import { strengthStyle } from "@/components/practice/practice-hub"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { cn } from "@/lib/utils"

/** Props for a session summary. */
type SessionSummaryProps = {
  projectId: string
  /** Limits the summary to one unit. */
  unitId?: string
  /** When the session started, in milliseconds since the epoch. */
  since: number
  /** Small label above the heading, such as "Drill complete". */
  eyebrow: string
  /** Heading; defaults to the score, or the sections taught when nothing was answered. */
  title?: string
  /** Extra content after the concept list, such as missed questions to relearn. */
  children?: ReactNode
  /** Next actions, shown last. */
  actions?: ReactNode
  /** Heading level, so the summary nests correctly in its page. */
  headingLevel?: "h1" | "h2"
}

/**
 * Formats a duration as minutes for the stats row.
 * @param ms Elapsed milliseconds.
 * @returns For example "14 min", or "<1 min".
 */
function minutes(ms: number): string {
  const value = Math.round(ms / 60_000)
  return value < 1 ? "<1 min" : `${value} min`
}

/**
 * Renders the summary for a session that started at `since`. Reactive, so an
 * answer recorded while it is open is counted straight away.
 */
export function SessionSummary({
  projectId,
  unitId,
  since,
  eyebrow,
  title,
  children,
  actions,
  headingLevel = "h2",
}: SessionSummaryProps) {
  const now = useMinuteClock()
  const summary = useQuery(api.progress.sessionSummary, {
    projectId: projectId as Id<"projects">,
    ...(unitId ? { unitId: unitId as Id<"units"> } : {}),
    since,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    now,
  })
  const Heading = headingLevel

  if (summary === undefined)
    return (
      <div className="space-y-4" aria-label="Loading your session summary">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </div>
    )

  const heading =
    title ??
    (summary.answered
      ? `${summary.correct} of ${summary.answered} correct`
      : summary.sections
        ? `${summary.sections} ${summary.sections === 1 ? "section" : "sections"} taught`
        : "No answers yet this session")
  const stats = [
    { label: "XP earned", value: `+${summary.xp}` },
    ...(summary.sections
      ? [
          {
            label: summary.sections === 1 ? "Section" : "Sections",
            value: String(summary.sections),
          },
        ]
      : []),
    ...(summary.answered
      ? [
          {
            label: "Correct",
            value: `${Math.round((summary.correct / summary.answered) * 100)}%`,
          },
        ]
      : []),
    { label: "Time", value: minutes(Math.max(0, now - since)) },
  ]
  const { today } = summary
  const remaining = Math.max(0, today.goal - today.xp)
  const streakText = today.streak.todayMet
    ? today.streak.current > 1
      ? `Today's goal is met. ${today.streak.current}-day streak.`
      : "Today's goal is met."
    : today.streak.current
      ? `${remaining} XP more keeps your ${today.streak.current}-day streak.`
      : `${remaining} XP more meets today's goal.`

  return (
    <section aria-labelledby="session-summary-title">
      <p className="text-xs font-medium text-brand">{eyebrow}</p>
      <Heading
        id="session-summary-title"
        className="mt-1 font-heading text-3xl font-semibold tracking-tight text-balance"
      >
        {heading}
      </Heading>

      <dl
        className={cn(
          "mt-5 grid gap-2",
          stats.length > 3 ? "grid-cols-2 sm:grid-cols-4" : "grid-cols-3"
        )}
      >
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border bg-card px-3 py-2.5"
          >
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="mt-0.5 font-heading text-xl font-semibold tabular-nums">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <p className="font-medium">Today</p>
          <p className="text-muted-foreground tabular-nums">
            {today.xp} of {today.goal} XP
          </p>
        </div>
        <Progress
          value={Math.min(100, (today.xp / Math.max(1, today.goal)) * 100)}
          aria-label={`${today.xp} of ${today.goal} XP today`}
          className="mt-2 h-2 [&_[data-slot=progress-indicator]]:bg-brand"
        />
        <p className="mt-2 text-sm text-muted-foreground">{streakText}</p>
      </div>

      {summary.concepts.length ? (
        <div className="mt-6">
          <h3 className="text-sm font-medium">Concepts</h3>
          <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-card">
            {summary.concepts.map((concept) => (
              <li
                key={concept.conceptId}
                className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span className="min-w-0 break-words">{concept.title}</span>
                <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {concept.correct} of {concept.answered}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 rounded-full",
                        strengthStyle[concept.strength].dot
                      )}
                    />
                    {strengthStyle[concept.strength].label}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {children}

      {actions ? (
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
      ) : null}
    </section>
  )
}
