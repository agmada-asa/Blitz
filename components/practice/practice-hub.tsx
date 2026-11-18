"use client"

/**
 * The module's Practice screen: the module's likely recall today, one drill
 * that asks missed and weak material first with the timed test and written
 * answers beside it, exam prep with past papers and mock exams, the concepts
 * that are not sticking with a way back into Teach, and each unit's question
 * bank (folded) with a way to write more questions.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { ExamPrep } from "@/components/practice/exam-prep"
import { SegmentedBar, type BarSegment } from "@/components/progress/progress-path"
import { Button } from "@/components/ui/button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ClockIcon,
  LoadingIcon,
  PencilIcon,
} from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import type { Id } from "@/convex/_generated/dataModel"
import type { ConceptStrength } from "@/lib/drill"
import { DEFAULT_BANK_BATCH } from "@/lib/practice"
import { armRelearn } from "@/lib/client/relearn"
import { relearnMessage } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Practice summary for one unit. */
type UnitPractice = FunctionReturnType<typeof api.practice.overview>["units"][number]

/**
 * Words and colours for each concept strength. Strength is one hue fading
 * out (strong, learning, needs work), so it reads the same in every accent
 * theme, where the brand colour can sit close to the destructive red.
 */
export const strengthStyle: Record<ConceptStrength, { label: string; dot: string }> = {
  weak: { label: "Needs work", dot: "bg-brand/30" },
  learning: { label: "Learning", dot: "bg-brand/60" },
  strong: { label: "Strong", dot: "bg-brand" },
  new: { label: "Not practised", dot: "bg-muted-foreground/40" },
}

/** Strengths from strongest to newest, the order concept bars are drawn in. */
const STRENGTH_ORDER: ConceptStrength[] = ["strong", "learning", "weak", "new"]

/** How much of a concept's bar segment is filled for each strength. */
const STRENGTH_FILL: Record<ConceptStrength, number> = { strong: 1, learning: 0.6, weak: 0.25, new: 0 }

/**
 * Draws concepts as bar segments grouped by strength, strongest first. Each
 * segment is filled as far as the concept is mastered (strong full, learning
 * most of the way, needs work a sliver, not practised empty) in its
 * strength's colour, so the bar reads as overall mastery.
 * @param concepts Concepts with an id and strength.
 */
function conceptSegments(concepts: Array<{ id: string; strength: ConceptStrength }>): BarSegment[] {
  return [...concepts]
    .sort((a, b) => STRENGTH_ORDER.indexOf(a.strength) - STRENGTH_ORDER.indexOf(b.strength))
    .map((concept) => ({
      key: concept.id,
      fill: STRENGTH_FILL[concept.strength],
      tone: strengthStyle[concept.strength].dot,
    }))
}

/** Counts concepts per strength as "3 strong · 2 learning", skipping empty groups. */
function strengthCounts(concepts: Array<{ strength: ConceptStrength }>): string {
  return STRENGTH_ORDER.map((strength) => {
    const count = concepts.filter((concept) => concept.strength === strength).length
    const label = strength === "weak" && count > 1 ? "need work" : strengthStyle[strength].label.toLowerCase()
    return count ? `${count} ${label}` : ""
  })
    .filter(Boolean)
    .join(" · ")
}

/**
 * Builds props for a Relearn link: the Teach URL carrying the request, and a
 * click handler that arms it so the Teach screen will send it.
 */
export function relearnLink(
  projectId: string,
  unitId: string,
  concept: string,
  question?: string
): { href: string; onClick: () => void } {
  const message = relearnMessage(concept, question)
  return {
    href: `/projects/${encodeURIComponent(projectId)}/learn/${encodeURIComponent(unitId)}?ask=${encodeURIComponent(message)}`,
    onClick: () => armRelearn(message),
  }
}

/** Renders the Practice screen for one module. */
export function PracticeHub({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, { projectId: convexProjectId })
  const now = useMinuteClock()
  const data = useQuery(api.practice.overview, { projectId: convexProjectId, now })
  const readiness = useQuery(api.progress.readiness, { projectId: convexProjectId, now })
  const base = `/projects/${encodeURIComponent(projectId)}`

  if (project === null)
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-8">
        <h1 className="font-heading text-2xl font-semibold">Project not found</h1>
        <Button asChild variant="outline" className="mt-5 min-h-11 rounded-full">
          <Link href="/">Back to projects</Link>
        </Button>
      </main>
    )

  const totalQuestions = data?.units.reduce((sum, unit) => sum + unit.questionCount, 0) ?? 0
  const allConcepts = data?.units.flatMap((unit) => unit.concepts) ?? []
  const drillSummary = data
    ? [
        data.missedCount ? `${data.missedCount} to retry` : "",
        data.weakConcepts.length
          ? `${data.weakConcepts.length} weak concept${data.weakConcepts.length === 1 ? "" : "s"}`
          : "",
        data.unansweredCount ? `${data.unansweredCount} new` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : ""

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9 text-muted-foreground">
        <Link href={base}>
          <ArrowLeftIcon aria-hidden="true" /> {project?.title ?? "Module"}
        </Link>
      </Button>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Practice</h1>
      {allConcepts.length ? (
        <RecallSummary concepts={allConcepts} readiness={readiness ?? undefined} />
      ) : null}

      {data === undefined ? (
        <div className="mt-6 space-y-4" aria-label="Loading practice">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          {/* Drill leads; the other two ways to practise sit beside it instead of at the bottom. */}
          <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <section className="flex flex-col gap-4 rounded-2xl border border-brand/25 bg-brand/[0.05] p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="font-heading text-lg font-semibold">Drill</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {totalQuestions
                    ? drillSummary || "Every question answered correctly. Drill to keep it fresh."
                    : "Write questions for a unit below to start drilling."}
                </p>
              </div>
              <Button
                asChild={totalQuestions > 0}
                disabled={!totalQuestions}
                className="min-h-11 shrink-0 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
              >
                {totalQuestions ? (
                  <Link href={`${base}/practice/drill`}>
                    Start drill <ArrowRightIcon aria-hidden="true" />
                  </Link>
                ) : (
                  <span>Start drill</span>
                )}
              </Button>
            </section>
            <PracticeModeLink
              href={`${base}/test`}
              icon={ClockIcon}
              label="Timed test"
              detail="Answers at the end"
            />
            <PracticeModeLink
              href={`${base}/write`}
              icon={PencilIcon}
              label="Written answers"
              detail="Explain in your own words"
            />
          </div>

          <ExamPrep projectId={projectId} />

          {data.weakConcepts.length ? (
            <WeakConcepts concepts={data.weakConcepts} projectId={projectId} base={base} />
          ) : null}

          <section aria-labelledby="units-heading" className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2 id="units-heading" className="flex items-baseline gap-2 font-heading text-lg font-semibold">
                Question banks
                {data.units.length ? (
                  <span className="text-sm font-normal text-muted-foreground">
                    {data.units.length} unit{data.units.length === 1 ? "" : "s"}
                  </span>
                ) : null}
              </h2>
              <ul aria-label="Concept strength key" className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {(["strong", "learning", "weak", "new"] as const).map((strength) => (
                  <li key={strength} className="flex items-center gap-1.5">
                    <span aria-hidden="true" className={cn("size-2 rounded-full", strengthStyle[strength].dot)} />
                    {strengthStyle[strength].label}
                  </li>
                ))}
              </ul>
            </div>
            <FailedBanks units={data.units} />
            {data.units.length ? (
              <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {data.units.map((unit) => (
                  <UnitBank key={unit.id} unit={unit} base={base} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                Add material to this module first; each unit gets its own questions.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  )
}

/**
 * The module's recall at a glance: the likely recall today as one large
 * number, and the concepts split by strength as one bar with a key. The number
 * is the same measure the screen called "Exam readiness"; it is not tied to an
 * exam date.
 * @param concepts Every concept in the module with its strength.
 * @param readiness The readiness query result; the number is left out until a concept is practised.
 */
function RecallSummary({
  concepts,
  readiness,
}: {
  concepts: Array<{ strength: ConceptStrength }>
  readiness?: FunctionReturnType<typeof api.progress.readiness>
}) {
  const counts = STRENGTH_ORDER.map((strength) => ({
    strength,
    count: concepts.filter((concept) => concept.strength === strength).length,
  })).filter((entry) => entry.count)
  const practised = readiness?.practised ? readiness : null
  return (
    <section
      aria-label="Recall"
      className="mt-5 flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:gap-7"
    >
      {practised ? (
        <p className="flex shrink-0 flex-col">
          <span className="font-heading text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {Math.round(practised.readiness * 100)}%
          </span>
          <span className="mt-1.5 text-sm text-muted-foreground">likely recall today</span>
        </p>
      ) : null}
      <div className="min-w-0 flex-1">
        {/* One bar split by strength, each part as wide as its share of concepts. */}
        <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
          {counts.map((entry) => (
            <span
              key={entry.strength}
              className={cn("h-full", strengthStyle[entry.strength].dot)}
              style={{ flexGrow: entry.count }}
            />
          ))}
        </div>
        <ul aria-label="Concepts by strength" className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {counts.map((entry) => (
            <li key={entry.strength} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2 rounded-full", strengthStyle[entry.strength].dot)} />
              <span className="tabular-nums">{entry.count}</span>{" "}
              {entry.strength === "weak" && entry.count > 1
                ? "need work"
                : strengthStyle[entry.strength].label.toLowerCase()}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {`${concepts.length} concept${concepts.length === 1 ? "" : "s"}`}
          {practised
            ? ` · ${practised.practised} practised, ${Math.round(practised.recallOfPractised * 100)}% recall on those`
            : ""}
        </p>
      </div>
    </section>
  )
}

/**
 * One of the secondary ways to practise, as a card beside Drill.
 * @param href Where the card leads.
 * @param icon The glyph shown above the label.
 * @param label The practice mode's name.
 * @param detail A few words on how the mode works.
 */
function PracticeModeLink({
  href,
  icon: Icon,
  label,
  detail,
}: {
  href: string
  icon: typeof ClockIcon
  label: string
  detail: string
}) {
  return (
    <Link
      href={href}
      className="flex min-h-20 items-center gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:flex-col sm:items-start sm:gap-2 sm:p-5"
    >
      <Icon aria-hidden="true" className="size-5 shrink-0 text-brand" />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-sm text-muted-foreground">{detail}</span>
      </span>
    </Link>
  )
}

/** How many weak concepts show before "Show all". */
const WEAK_PREVIEW = 5

/**
 * The concepts that are not sticking, each with Relearn and Drill unit. Shows
 * the first five, weakest first as the query orders them, with a button for
 * the rest.
 */
function WeakConcepts({
  concepts,
  projectId,
  base,
}: {
  concepts: FunctionReturnType<typeof api.practice.overview>["weakConcepts"]
  projectId: string
  /** The module's URL prefix, `/projects/<id>`. */
  base: string
}) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? concepts : concepts.slice(0, WEAK_PREVIEW)
  return (
    <section aria-labelledby="weak-heading" className="mt-10">
      <h2 id="weak-heading" className="flex items-baseline gap-2 font-heading text-lg font-semibold">
        Not sticking yet
        <span className="text-sm font-normal text-muted-foreground tabular-nums">{concepts.length}</span>
      </h2>
      <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-card">
        <ul id="weak-concepts" className="divide-y divide-border">
          {shown.map((concept) => (
            <li
              key={concept.id}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
            >
              <div className="min-w-0">
                <p className="font-medium break-words">{concept.title}</p>
                <p className="text-xs text-muted-foreground">
                  {concept.unitTitle}
                  {concept.accuracy !== null
                    ? ` · ${Math.round(concept.accuracy * 100)}% correct over ${concept.attempts} answer${concept.attempts === 1 ? "" : "s"}`
                    : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button asChild variant="ghost" className="min-h-10 rounded-full px-3.5 text-muted-foreground">
                  <Link href={`${base}/practice/drill?unit=${encodeURIComponent(concept.unitId)}`}>
                    Drill unit
                  </Link>
                </Button>
                <Button asChild variant="outline" className="min-h-10 rounded-full px-4">
                  <Link {...relearnLink(projectId, concept.unitId, concept.title)}>Relearn</Link>
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {concepts.length > WEAK_PREVIEW ? (
          <button
            type="button"
            aria-expanded={showAll}
            aria-controls="weak-concepts"
            onClick={() => setShowAll((all) => !all)}
            className="flex min-h-11 w-full items-center border-t border-border px-4 text-left text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset sm:px-5"
          >
            {showAll ? "Show fewer" : `Show all ${concepts.length}`}
          </button>
        ) : null}
      </div>
    </section>
  )
}

/** localStorage key for the failed question runs the learner has dismissed, by generation ID. */
const DISMISSED_FAILURES_KEY = "blitz-dismissed-question-failures"

/** Reads the dismissed generation IDs; an unreadable value counts as none. */
function readDismissedFailures(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(DISMISSED_FAILURES_KEY) ?? "[]")
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/**
 * Starts a batch of questions for one unit.
 * @returns An error message to show, or an empty string when the run started.
 */
async function startQuestionBatch(unitId: string): Promise<string> {
  const response = await fetch("/api/practice/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitId, count: DEFAULT_BANK_BATCH }),
  }).catch(() => null)
  if (response?.ok) return ""
  const payload = (await response?.json().catch(() => null)) as { error?: string } | null
  return payload?.error ?? "Questions could not be started. Try again."
}

/**
 * Every unit whose latest question run failed, as one line instead of an alert
 * per unit. Retry starts each again; Dismiss hides these failures in this
 * browser until another run fails. Renders nothing when no failure is showing.
 */
function FailedBanks({ units }: { units: UnitPractice[] }) {
  // Rendered only once the practice query has loaded in the browser, so storage is readable here.
  const [dismissed, setDismissed] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : readDismissedFailures()
  )
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState("")

  const failed = units.filter(
    (unit) => unit.generation?.status === "failed" && !dismissed.includes(unit.generation.id)
  )
  if (!failed.length) return null

  /** Starts every failed unit again and reports the first problem. */
  async function retry() {
    setRetrying(true)
    setError("")
    const errors = await Promise.all(failed.map((unit) => startQuestionBatch(unit.id)))
    setRetrying(false)
    setError(errors.find(Boolean) ?? "")
  }

  /** Hides the current failures and remembers that in this browser. */
  function dismiss() {
    const next = [...dismissed, ...failed.map((unit) => String(unit.generation?.id))]
    setDismissed(next)
    try {
      window.localStorage.setItem(DISMISSED_FAILURES_KEY, JSON.stringify(next.slice(-200)))
    } catch {
      // Storage can be full or blocked; the line stays hidden until the page reloads.
    }
  }

  const names = failed.map((unit) => unit.title).join(", ")
  return (
    <div
      role="alert"
      className="mt-3 flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5 text-sm sm:flex-row sm:items-center"
    >
      <p className="flex min-w-0 flex-1 items-start gap-2.5">
        <AlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <span className="min-w-0">
          <span title={names}>
            {failed.length === 1
              ? `Questions for ${failed[0]!.title} couldn't be written.`
              : `${failed.length} question sets couldn't be written.`}
          </span>
          {error ? <span className="block text-destructive">{error}</span> : null}
        </span>
      </p>
      <div className="flex shrink-0 gap-1 self-end sm:self-auto">
        <Button
          type="button"
          variant="ghost"
          disabled={retrying}
          onClick={() => void retry()}
          className="min-h-9 rounded-full px-3"
        >
          {retrying ? (
            <>
              <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Retrying
            </>
          ) : (
            "Retry"
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={retrying}
          onClick={dismiss}
          className="min-h-9 rounded-full px-3 text-muted-foreground"
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

/**
 * One unit's question bank as a folded row: the title, counts and actions stay
 * in view, and the concept strengths open under it. A run that is writing
 * questions shows in the row; a failed run is reported once for the whole
 * list by `FailedBanks`.
 */
function UnitBank({ unit, base }: { unit: UnitPractice; base: string }) {
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const running = unit.generation?.status === "running"
  const accuracy = unit.answeredCount
    ? Math.round((unit.correctCount / unit.answeredCount) * 100)
    : null
  const panelId = `bank-${unit.id}`

  /** Asks the tutor for another batch of questions for this unit. */
  async function writeQuestions() {
    setStarting(true)
    setError("")
    setError(await startQuestionBatch(unit.id))
    setStarting(false)
  }

  return (
    <li>
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:px-4">
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            disabled={!unit.concepts.length}
            onClick={() => setOpen((value) => !value)}
            className="flex w-full items-start gap-2.5 rounded-lg px-1 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
          >
            <ArrowRightIcon
              aria-hidden="true"
              className={cn(
                "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                open && "rotate-90",
                !unit.concepts.length && "opacity-0"
              )}
            />
            <span className="min-w-0">
              <span className="block font-medium break-words">{unit.title}</span>
              <span className="block text-xs text-muted-foreground">
                {running && unit.generation ? (
                  <span role="status">
                    Writing questions… <ElapsedTime since={unit.generation.startedAt} />
                  </span>
                ) : (
                  <>
                    {unit.questionCount} question{unit.questionCount === 1 ? "" : "s"}
                    {unit.concepts.length
                      ? ` · ${unit.concepts.length} concept${unit.concepts.length === 1 ? "" : "s"}`
                      : ""}
                    {accuracy !== null ? ` · ${accuracy}% correct` : ""}
                  </>
                )}
              </span>
            </span>
          </button>
        </h3>
        <div className="flex shrink-0 flex-wrap gap-1 pl-7 sm:pl-0">
          {unit.questionCount ? (
            <Button asChild variant="outline" className="min-h-10 rounded-full px-4">
              <Link href={`${base}/practice/drill?unit=${encodeURIComponent(unit.id)}`}>Practice</Link>
            </Button>
          ) : null}
          <Button
            type="button"
            variant={unit.questionCount ? "ghost" : "outline"}
            disabled={running || starting}
            onClick={() => void writeQuestions()}
            className={cn("min-h-10 rounded-full px-3.5", unit.questionCount && "text-muted-foreground")}
          >
            {running || starting ? (
              <>
                <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Writing
              </>
            ) : unit.questionCount ? (
              `Write ${DEFAULT_BANK_BATCH} more`
            ) : (
              `Write ${DEFAULT_BANK_BATCH} questions`
            )}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-3 pl-11 text-xs text-destructive sm:pl-12">
          {error}
        </p>
      ) : null}
      {unit.concepts.length ? (
        <div id={panelId} hidden={!open} className="px-4 pb-4 pl-11 sm:pl-12">
          <SegmentedBar size="sm" segments={conceptSegments(unit.concepts)} />
          <p className="mt-1.5 text-xs text-muted-foreground">{strengthCounts(unit.concepts)}</p>
          <ul aria-label={`${unit.title} concepts`} className="mt-3 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
            {unit.concepts.map((concept) => (
              <li key={concept.id} className="flex min-w-0 items-center gap-2 text-sm">
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", strengthStyle[concept.strength].dot)} />
                <span className="truncate">{concept.title}</span>
                <span className="sr-only">: {strengthStyle[concept.strength].label}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </li>
  )
}
