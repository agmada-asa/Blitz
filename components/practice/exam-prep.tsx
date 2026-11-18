"use client"

/**
 * The Exam prep section of the Practice screen: the module's past papers and
 * mock exams as compact rows with their status, size, and best score in a
 * column, actions to take, resume, review, edit, or delete each one, and the
 * two ways to add a paper.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { AddPastPaperDialog, WriteMockExamDialog } from "@/components/practice/exam-dialogs"
import { ExamPaperActions } from "@/components/practice/exam-paper-actions"
import { Button } from "@/components/ui/button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { LoadingIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** One paper in the Exam prep list. */
type PaperSummary = FunctionReturnType<typeof api.exam.listPapers>[number]

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Renders the Exam prep section for one module. */
export function ExamPrep({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const papers = useQuery(api.exam.listPapers, { projectId: convexProjectId })
  const units = useQuery(api.units.listForProject, { projectId: convexProjectId })
  const [pastOpen, setPastOpen] = useState(false)
  const [mockOpen, setMockOpen] = useState(false)
  const base = `/projects/${encodeURIComponent(projectId)}`
  const unitsWithMaterial = (units?.units ?? [])
    .filter((unit) => unit.sources.some((source) => source.hasText))
    .map((unit) => ({ id: String(unit.id), title: unit.title }))

  return (
    <section aria-labelledby="exam-heading" className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id="exam-heading" className="font-heading text-lg font-semibold">
          Exam prep
        </h2>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setPastOpen(true)}
            className="min-h-10 rounded-full px-3.5 text-muted-foreground"
          >
            Add a past paper
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!unitsWithMaterial.length}
            onClick={() => setMockOpen(true)}
            className="min-h-10 rounded-full px-4"
          >
            Write a mock exam
          </Button>
        </div>
      </div>

      {papers === undefined ? (
        <Skeleton className="mt-3 h-20 w-full rounded-2xl" aria-label="Loading exam papers" />
      ) : papers.length ? (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {papers.map((paper) => (
            <PaperRow key={paper.id} paper={paper} base={base} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {unitsWithMaterial.length
            ? "No papers yet. Add a past paper, or write a mock exam from your units."
            : "No papers yet. Add a past paper, or add material to a unit to write a mock exam."}
        </p>
      )}

      <AddPastPaperDialog projectId={projectId} open={pastOpen} onOpenChange={setPastOpen} />
      <WriteMockExamDialog
        projectId={projectId}
        units={unitsWithMaterial}
        open={mockOpen}
        onOpenChange={setMockOpen}
      />
    </section>
  )
}

/** Shows one paper with its status and the actions that fit it. */
function PaperRow({ paper, base }: { paper: PaperSummary; base: string }) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState("")
  const href = `${base}/practice/exam/${encodeURIComponent(paper.id)}`
  const details = [
    paper.kind === "past" ? "Past paper" : "Mock exam",
    paper.status === "ready" ? plural(paper.questionCount, "question") : "",
    paper.status === "ready" && paper.totalMarks ? plural(paper.totalMarks, "mark") : "",
    paper.durationMinutes ? `${paper.durationMinutes} min` : "",
  ].filter(Boolean)

  /** Starts preparing a failed paper again. */
  async function retry() {
    setRetrying(true)
    setError("")
    const response = await fetch("/api/practice/exam/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperId: paper.id }),
    }).catch(() => null)
    setRetrying(false)
    if (!response?.ok) setError("The paper could not be retried. Try again.")
  }

  // Once a paper has a result, reviewing it is the likelier next step, so Review takes the outline.
  const reviewFirst = Boolean(paper.latestAttemptId) && !paper.inProgressAttemptId

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h3 className="font-medium break-words">{paper.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{details.join(" · ")}</p>
          {paper.status === "ready" && paper.readFromScan ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Scanned PDF · read as a document
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {paper.status === "ready" ? (
            <>
              <span className="mr-2 min-w-[4.5rem] text-right text-sm text-muted-foreground tabular-nums max-sm:order-last max-sm:ml-auto">
                {paper.bestPercentage !== null ? (
                  <>
                    <span className="sr-only">Best </span>
                    {paper.bestPercentage}%
                  </>
                ) : paper.inProgressAttemptId ? (
                  "In progress"
                ) : (
                  "Not taken"
                )}
              </span>
              <Button
                asChild
                variant={reviewFirst ? "ghost" : "outline"}
                className={cn("min-h-10 rounded-full px-4", reviewFirst && "text-muted-foreground")}
              >
                <Link href={href}>{paper.inProgressAttemptId ? "Resume" : "Take"}</Link>
              </Button>
              {paper.latestAttemptId ? (
                <Button
                  asChild
                  variant={reviewFirst ? "outline" : "ghost"}
                  className="min-h-10 rounded-full px-4"
                >
                  <Link href={`${href}?attempt=${encodeURIComponent(paper.latestAttemptId)}`}>
                    Review
                  </Link>
                </Button>
              ) : null}
            </>
          ) : paper.status === "failed" ? (
            <Button
              type="button"
              variant="outline"
              disabled={retrying}
              onClick={() => void retry()}
              className="min-h-10 rounded-full px-4"
            >
              {retrying ? (
                <>
                  <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Retrying
                </>
              ) : (
                "Try again"
              )}
            </Button>
          ) : null}
          <ExamPaperActions
            paper={{
              id: paper.id,
              title: paper.title,
              status: paper.status,
              changeLock: paper.changeLock,
              hasOpenAttempt: Boolean(paper.inProgressAttemptId),
            }}
            editHref={`${href}?edit=1`}
          />
        </div>
      </div>
      {paper.status === "processing" ? (
        <p role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <LoadingIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
          {paper.kind === "past" ? "Reading the paper's questions…" : "Writing the mock exam…"}{" "}
          <ElapsedTime since={paper.runStartedAt} />
        </p>
      ) : null}
      {paper.status === "failed" && paper.error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {paper.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}
