"use client"

/**
 * The module's Practice screen: one drill that asks missed and weak material
 * first, the concepts that are not sticking with a way back into Teach, and
 * each unit's question bank with a way to write more questions.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { ArrowLeftIcon, ArrowRightIcon, LoadingIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ConceptStrength } from "@/lib/drill"
import { DEFAULT_BANK_BATCH } from "@/lib/practice"
import { relearnMessage } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Practice summary for one unit. */
type UnitPractice = FunctionReturnType<typeof api.practice.overview>["units"][number]

/** Words and colours for each concept strength. */
const strengthStyle: Record<ConceptStrength, { label: string; dot: string }> = {
  weak: { label: "Needs work", dot: "bg-destructive" },
  learning: { label: "Learning", dot: "bg-brand/50" },
  strong: { label: "Strong", dot: "bg-brand" },
  new: { label: "Not practised", dot: "bg-muted-foreground/40" },
}

/** Builds the Teach link that re-teaches a concept the learner keeps missing. */
export function relearnHref(
  projectId: string,
  unitId: string,
  concept: string,
  question?: string
): string {
  return `/projects/${encodeURIComponent(projectId)}/learn/${encodeURIComponent(unitId)}?ask=${encodeURIComponent(relearnMessage(concept, question))}`
}

/** Renders the Practice screen for one module. */
export function PracticeHub({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, { projectId: convexProjectId })
  const data = useQuery(api.practice.overview, { projectId: convexProjectId })
  const base = `/projects/${encodeURIComponent(projectId)}`

  if (project === null)
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-8">
        <h1 className="font-heading text-2xl font-semibold">Project not found</h1>
        <Button asChild variant="outline" className="mt-5 min-h-11 rounded-full">
          <Link href="/library">Back to projects</Link>
        </Button>
      </main>
    )

  const totalQuestions = data?.units.reduce((sum, unit) => sum + unit.questionCount, 0) ?? 0
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
    <main className="mx-auto w-full max-w-4xl px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href={base}>
          <ArrowLeftIcon aria-hidden="true" /> {project?.title ?? "Module"}
        </Link>
      </Button>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Practice</h1>

      {data === undefined ? (
        <div className="mt-8 space-y-4" aria-label="Loading practice">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-40 w-full rounded-2xl" />
        </div>
      ) : (
        <>
          <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-brand/25 bg-brand/[0.05] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="min-w-0">
              <h2 className="font-heading text-xl font-semibold">Drill</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {totalQuestions
                  ? drillSummary || "Every question answered correctly. Drill to keep it fresh."
                  : "Write questions for a unit below to start drilling."}
              </p>
            </div>
            <Button
              asChild={totalQuestions > 0}
              disabled={!totalQuestions}
              className="min-h-11 w-full shrink-0 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85 sm:w-auto"
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

          {data.weakConcepts.length ? (
            <section aria-labelledby="weak-heading" className="mt-10">
              <h2 id="weak-heading" className="font-heading text-lg font-semibold">
                Not sticking yet
              </h2>
              <ul className="mt-3 divide-y divide-border rounded-xl border border-border bg-card">
                {data.weakConcepts.map((concept) => (
                  <li
                    key={concept.id}
                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
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
                    <div className="flex shrink-0 gap-2">
                      <Button asChild variant="outline" className="min-h-10 rounded-full px-4">
                        <Link href={relearnHref(projectId, concept.unitId, concept.title)}>Relearn</Link>
                      </Button>
                      <Button asChild variant="ghost" className="min-h-10 rounded-full px-4">
                        <Link href={`${base}/practice/drill?unit=${encodeURIComponent(concept.unitId)}`}>
                          Drill unit
                        </Link>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="units-heading" className="mt-10">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2 id="units-heading" className="font-heading text-lg font-semibold">
                Question banks
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
            {data.units.length ? (
              <ul className="mt-3 space-y-3">
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

          <nav aria-label="Other practice" className="mt-10 flex flex-wrap gap-2">
            <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
              <Link href={`${base}/test`}>Timed test</Link>
            </Button>
            <Button asChild variant="outline" className="min-h-11 rounded-full px-5">
              <Link href={`${base}/write`}>Written answers</Link>
            </Button>
          </nav>
        </>
      )}
    </main>
  )
}

/** Shows one unit's question bank, concept strengths, and generation state. */
function UnitBank({ unit, base }: { unit: UnitPractice; base: string }) {
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const running = unit.generation?.status === "running"
  const failed = unit.generation?.status === "failed"
  const accuracy = unit.answeredCount
    ? Math.round((unit.correctCount / unit.answeredCount) * 100)
    : null

  /** Asks the tutor for another batch of questions for this unit. */
  async function writeQuestions() {
    setStarting(true)
    setError("")
    const response = await fetch("/api/practice/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unitId: unit.id, count: DEFAULT_BANK_BATCH }),
    }).catch(() => null)
    setStarting(false)
    if (!response?.ok) {
      const payload = (await response?.json().catch(() => null)) as { error?: string } | null
      setError(payload?.error ?? "Questions could not be started. Try again.")
    }
  }

  return (
    <li className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="font-medium break-words">{unit.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {unit.questionCount} question{unit.questionCount === 1 ? "" : "s"}
            {unit.answeredCount ? ` · ${unit.answeredCount} answered` : ""}
            {accuracy !== null ? ` · ${accuracy}% correct` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
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
            className="min-h-10 rounded-full px-4"
          >
            {running || starting ? (
              <>
                <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Writing questions
              </>
            ) : unit.questionCount ? (
              `Write ${DEFAULT_BANK_BATCH} more`
            ) : (
              `Write ${DEFAULT_BANK_BATCH} questions`
            )}
          </Button>
        </div>
      </div>
      {running && unit.generation ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Writing exam-style questions from this unit&apos;s material… <ElapsedTime since={unit.generation.startedAt} />
        </p>
      ) : null}
      {failed && unit.generation?.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {unit.generation.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {unit.concepts.length ? (
        <ul aria-label={`${unit.title} concepts`} className="mt-4 flex flex-wrap gap-1.5">
          {unit.concepts.map((concept) => (
            <li
              key={concept.id}
              className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs"
            >
              <span aria-hidden="true" className={cn("size-2 rounded-full", strengthStyle[concept.strength].dot)} />
              <span className="max-w-[16rem] truncate">{concept.title}</span>
              <span className="sr-only">: {strengthStyle[concept.strength].label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
