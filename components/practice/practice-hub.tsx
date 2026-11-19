"use client"

/**
 * The project's Practice screen. One summary card leads: exam readiness, a
 * strength bar with its key, and the drill as the single primary action, with
 * timed tests and written answers beside it. Below it, three tabs keep only
 * one list on screen at a time: Exams (past papers and mock exams), Weak
 * topics (concepts that aren't sticking, merged across units) and Units (each
 * unit's question bank and concepts).
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { PageContainer } from "@/components/page-container"
import { ExamPrep } from "@/components/practice/exam-prep"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { AddIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, LoadingIcon, RefreshIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api } from "@/convex/_generated/api"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import type { Id } from "@/convex/_generated/dataModel"
import { mergeWeakTopics, type ConceptStrength, type WeakTopic as WeakTopicOf } from "@/lib/drill"
import { DEFAULT_BANK_BATCH } from "@/lib/practice"
import { armRelearn } from "@/lib/client/relearn"
import { relearnMessage } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Practice data for one project. */
type PracticeOverview = FunctionReturnType<typeof api.practice.overview>

/** Practice summary for one unit. */
type UnitPractice = PracticeOverview["units"][number]

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

/** Strengths from strongest to newest, the order bars and keys are drawn in. */
const STRENGTH_ORDER: ConceptStrength[] = ["strong", "learning", "weak", "new"]

/** Concepts per strength. */
type StrengthCounts = Record<ConceptStrength, number>

/** Counts concepts per strength. */
function countStrengths(concepts: Array<{ strength: ConceptStrength }>): StrengthCounts {
  const counts: StrengthCounts = { strong: 0, learning: 0, weak: 0, new: 0 }
  for (const concept of concepts) counts[concept.strength] += 1
  return counts
}

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
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

/** A weak topic in this project, merged across units by `mergeWeakTopics`. */
type WeakTopic = WeakTopicOf<Id<"units">>

/** Renders the Practice screen for one project. */
export function PracticeHub({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, { projectId: convexProjectId })
  const now = useMinuteClock()
  const data = useQuery(api.practice.overview, { projectId: convexProjectId, now })
  const readiness = useQuery(api.progress.readiness, { projectId: convexProjectId, now })
  const papers = useQuery(api.exam.listPapers, { projectId: convexProjectId })
  const base = `/projects/${encodeURIComponent(projectId)}`

  if (project === null)
    return (
      <PageContainer>
        <h1 className="font-heading text-2xl font-semibold">Project not found</h1>
        <Button asChild variant="outline" className="mt-5 min-h-11 rounded-full">
          <Link href="/">Back to projects</Link>
        </Button>
      </PageContainer>
    )

  const weakTopics = data ? mergeWeakTopics(data.weakConcepts) : []

  return (
    <PageContainer className="text-foreground">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href={base}>
          <ArrowLeftIcon aria-hidden="true" /> {project?.title ?? "Project"}
        </Link>
      </Button>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Practice</h1>

      {data === undefined ? (
        <div className="mt-6 space-y-4" aria-label="Loading practice">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-10 w-72 rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <Summary data={data} readiness={readiness} weakCount={weakTopics.length} base={base} />

          <Tabs defaultValue="exams" className="mt-10 gap-4">
            <TabsList className="h-10 w-full sm:w-fit">
              <TabsTrigger value="exams" className="h-8 flex-1 gap-1.5 sm:flex-none">
                Exams {papers?.length ? <TabCount>{papers.length}</TabCount> : null}
              </TabsTrigger>
              <TabsTrigger value="weak" className="h-8 flex-1 gap-1.5 sm:flex-none">
                Weak topics {weakTopics.length ? <TabCount>{weakTopics.length}</TabCount> : null}
              </TabsTrigger>
              <TabsTrigger value="units" className="h-8 flex-1 gap-1.5 sm:flex-none">
                Units {data.units.length ? <TabCount>{data.units.length}</TabCount> : null}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="exams">
              <ExamPrep projectId={projectId} />
            </TabsContent>
            <TabsContent value="weak">
              <WeakTopics topics={weakTopics} projectId={projectId} base={base} />
            </TabsContent>
            <TabsContent value="units">
              <UnitBanks units={data.units} base={base} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </PageContainer>
  )
}

/** A quiet count after a tab label. */
function TabCount({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{children}</span>
}

/**
 * Draws strength counts as one continuous bar, strongest first, so the share
 * of each strength reads at a glance.
 * @param size `md` for the project summary, `sm` inside unit rows.
 */
function StrengthBar({
  counts,
  size = "md",
  className,
}: {
  counts: StrengthCounts
  size?: "sm" | "md"
  className?: string
}) {
  const total = STRENGTH_ORDER.reduce((sum, strength) => sum + counts[strength], 0)
  if (!total) return null
  return (
    <div aria-hidden="true" className={cn("flex w-full gap-0.5", size === "sm" ? "h-1.5" : "h-2", className)}>
      {STRENGTH_ORDER.filter((strength) => counts[strength]).map((strength) => (
        <span
          key={strength}
          className={cn(
            "h-full min-w-1.5 rounded-full transition-[width] duration-400 ease-out motion-reduce:transition-none",
            strengthStyle[strength].dot
          )}
          style={{ width: `${(counts[strength] / total) * 100}%` }}
        />
      ))}
    </div>
  )
}

/**
 * The summary card: readiness as the headline number with the strength bar
 * and key under it, the drill as the primary action, and the two other
 * practice modes as secondary buttons.
 */
function Summary({
  data,
  readiness,
  weakCount,
  base,
}: {
  data: PracticeOverview
  readiness: FunctionReturnType<typeof api.progress.readiness> | undefined
  weakCount: number
  base: string
}) {
  const allConcepts = data.units.flatMap((unit) => unit.concepts)
  const counts = countStrengths(allConcepts)
  const totalQuestions = data.units.reduce((sum, unit) => sum + unit.questionCount, 0)
  const drillSummary = [
    data.missedCount ? `${data.missedCount} to retry` : "",
    weakCount ? `${weakCount} weak` : "",
    data.unansweredCount ? `${data.unansweredCount} new` : "",
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <section
      aria-label="Readiness and drill"
      className="mt-6 grid gap-6 rounded-2xl border border-border bg-card p-5 sm:p-6 md:grid-cols-[1fr_auto] md:items-center md:gap-10"
    >
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">Exam readiness</p>
        {readiness?.practised ? (
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-heading text-5xl font-semibold tracking-tight tabular-nums">
              {Math.round(readiness.readiness * 100)}%
            </span>
            <span className="text-sm text-muted-foreground">
              {readiness.practised} of {plural(readiness.concepts, "topic")} practised ·{" "}
              {Math.round(readiness.recallOfPractised * 100)}% recall on those
            </span>
          </p>
        ) : (
          <p className="mt-1 text-sm">
            {allConcepts.length
              ? "Drill once to see how much of this project you'd recall today."
              : "Generate questions for a unit to start practising."}
          </p>
        )}
        {allConcepts.length ? (
          <>
            <StrengthBar counts={counts} className="mt-4 mb-2.5" />
            <ul
              aria-label="Topics by strength"
              className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
            >
              {STRENGTH_ORDER.map((strength) => (
                <li key={strength} className="flex items-center gap-1.5">
                  <span aria-hidden="true" className={cn("size-2 rounded-full", strengthStyle[strength].dot)} />
                  <span className="font-medium text-foreground tabular-nums">{counts[strength]}</span>
                  {strengthStyle[strength].label.toLowerCase()}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 md:w-64">
        <Button
          asChild={totalQuestions > 0}
          disabled={!totalQuestions}
          className="min-h-12 rounded-full bg-brand text-base text-brand-foreground hover:bg-brand/85"
        >
          {totalQuestions ? (
            <Link href={`${base}/practice/drill`}>
              Start drill <ArrowRightIcon aria-hidden="true" />
            </Link>
          ) : (
            <span>Start drill</span>
          )}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {totalQuestions ? drillSummary || "All answered correctly. Drill to keep it fresh." : "No questions yet"}
        </p>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <Button asChild variant="outline" className="min-h-10 rounded-full px-3">
            <Link href={`${base}/test`}>Timed test</Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10 rounded-full px-3">
            <Link href={`${base}/write`}>Written answers</Link>
          </Button>
        </div>
      </div>
    </section>
  )
}

/**
 * The Weak topics tab: concepts that aren't sticking, one row each with its
 * units, how many answers were right, and Relearn. One button drills them all.
 */
function WeakTopics({ topics, projectId, base }: { topics: WeakTopic[]; projectId: string; base: string }) {
  if (!topics.length)
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Nothing is slipping. Topics you miss show up here.
      </p>
    )
  return (
    <section aria-label="Weak topics">
      <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm text-muted-foreground">Missed last time, or under 60% after two tries.</p>
        <Button asChild variant="outline" className="min-h-10 rounded-full px-4">
          <Link href={`${base}/practice/drill?focus=weak`}>Drill these {topics.length}</Link>
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {topics.map((topic) => (
          <li key={topic.title} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{topic.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {topic.units.map((unit) => unit.title).join(" · ")}
              </p>
            </div>
            {topic.answers ? (
              <span className="hidden w-24 shrink-0 items-center gap-2 sm:flex">
                <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full bg-brand/60"
                    style={{ width: `${(topic.right / topic.answers) * 100}%` }}
                  />
                </span>
                <span className="w-7 text-right text-xs text-muted-foreground tabular-nums">
                  {topic.right}/{topic.answers}
                  <span className="sr-only"> right</span>
                </span>
              </span>
            ) : null}
            <Button asChild variant="outline" className="min-h-10 w-24 shrink-0 rounded-full">
              <Link {...relearnLink(projectId, topic.units[0].id, topic.title)}>Relearn</Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Asks the tutor for another batch of questions for a unit.
 * @returns An error message, or an empty string when the run started.
 */
async function generateQuestions(unitId: string): Promise<string> {
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
 * The Units tab: one row per unit, with failed question runs gathered into a
 * single notice that retries them together.
 */
function UnitBanks({ units, base }: { units: UnitPractice[]; base: string }) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState("")
  const failed = units.filter((unit) => unit.generation?.status === "failed")

  /** Starts a new question run for every unit whose last run failed. */
  async function retryFailed() {
    setRetrying(true)
    setRetryError("")
    const errors = await Promise.all(failed.map((unit) => generateQuestions(unit.id)))
    setRetrying(false)
    const firstError = errors.find(Boolean)
    if (firstError) setRetryError(firstError)
  }

  if (!units.length)
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
        Add material to this project first; each unit gets its own questions.
      </p>
    )

  return (
    <section aria-label="Units">
      {failed.length ? (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm"
        >
          <span className="min-w-0">
            New questions couldn&apos;t be generated for{" "}
            {failed.length === 1 ? failed[0].title : plural(failed.length, "unit")}.
            {retryError ? <span className="block text-xs text-destructive">{retryError}</span> : null}
          </span>
          <Button
            type="button"
            variant="ghost"
            disabled={retrying}
            onClick={() => void retryFailed()}
            className="min-h-10 rounded-full px-3"
          >
            {retrying ? (
              <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" />
            ) : (
              <RefreshIcon aria-hidden="true" />
            )}
            Try again
          </Button>
        </div>
      ) : null}
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {units.map((unit) => (
          <UnitRow key={unit.id} unit={unit} base={base} />
        ))}
      </ul>
    </section>
  )
}

/** One unit, closed to a single line until opened to show its concepts. */
function UnitRow({ unit, base }: { unit: UnitPractice; base: string }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const running = unit.generation?.status === "running"
  const accuracy = unit.answeredCount ? Math.round((unit.correctCount / unit.answeredCount) * 100) : null
  const counts = countStrengths(unit.concepts)
  const busy = running || starting

  /** Starts another batch of questions for this unit. */
  async function generate() {
    setStarting(true)
    setError(await generateQuestions(unit.id))
    setStarting(false)
  }

  const generateButton = (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      onClick={() => void generate()}
      className="min-h-10 rounded-full px-4"
    >
      {busy ? (
        <>
          <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Generating
        </>
      ) : unit.questionCount ? (
        <>
          <AddIcon aria-hidden="true" /> Generate {DEFAULT_BANK_BATCH} more
        </>
      ) : (
        <>
          Generate<span className="hidden sm:inline"> questions</span>
        </>
      )}
    </Button>
  )

  return (
    <li>
      <Collapsible>
        <div className="flex items-center gap-3 px-4 py-3">
          <CollapsibleTrigger
            disabled={!unit.concepts.length}
            className="group/unit flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{unit.title}</span>
              <span className="block text-xs text-muted-foreground">
                {running && unit.generation ? (
                  <>
                    Generating questions… <ElapsedTime since={unit.generation.startedAt} />
                  </>
                ) : unit.questionCount ? (
                  `${plural(unit.questionCount, "question")}${accuracy !== null ? ` · ${accuracy}% correct` : " · not started"}`
                ) : (
                  "No questions yet"
                )}
              </span>
            </span>
            <StrengthBar counts={counts} size="sm" className="hidden w-28 shrink-0 sm:flex" />
            {unit.concepts.length ? (
              <>
                <ArrowDownIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/unit:rotate-180 motion-reduce:transition-none"
                />
                <span className="sr-only">Show topics</span>
              </>
            ) : null}
          </CollapsibleTrigger>
          <div className="flex shrink-0 justify-end sm:w-44">
            {unit.questionCount ? (
              <Button asChild variant="outline" className="min-h-10 w-24 rounded-full">
                <Link href={`${base}/practice/drill?unit=${encodeURIComponent(unit.id)}`}>Practice</Link>
              </Button>
            ) : (
              generateButton
            )}
          </div>
        </div>
        {error ? (
          <p role="alert" className="-mt-1 px-4 pb-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <CollapsibleContent className="border-t border-border bg-muted/30 px-4 py-4">
          <ul aria-label={`${unit.title} topics`} className="gap-x-6 sm:columns-2 [&>li]:mb-1.5 [&>li]:break-inside-avoid">
            {STRENGTH_ORDER.flatMap((strength) =>
              unit.concepts
                .filter((concept) => concept.strength === strength)
                .map((concept) => (
                  <li key={concept.id} className="flex min-w-0 items-center gap-2 text-sm">
                    <span
                      aria-hidden="true"
                      className={cn("size-2 shrink-0 rounded-full", strengthStyle[concept.strength].dot)}
                    />
                    <span className="truncate">{concept.title}</span>
                    <span className="sr-only">: {strengthStyle[concept.strength].label}</span>
                  </li>
                ))
            )}
          </ul>
          {unit.questionCount ? <div className="mt-3">{generateButton}</div> : null}
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}
