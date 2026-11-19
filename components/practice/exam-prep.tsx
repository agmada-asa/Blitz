"use client"

/**
 * The Exams tab of the Practice screen: the project's past papers and mock
 * exams as rows in one list, each with its best score, one visible action
 * (take, resume or try again) and a menu for reviewing, editing or deleting,
 * plus the New exam menu that uploads a past paper or generates a mock exam.
 */

import Link from "next/link"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { AddPastPaperDialog, WriteMockExamDialog } from "@/components/practice/exam-dialogs"
import { ExamPaperActions } from "@/components/practice/exam-paper-actions"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { AddIcon, LoadingIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** One paper in the Exams list. */
type PaperSummary = FunctionReturnType<typeof api.exam.listPapers>[number]

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Renders the Exams tab for one project. */
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
    <section aria-label="Exams">
      <div className="mb-3 flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" className="min-h-10 rounded-full px-4">
              <AddIcon aria-hidden="true" /> New exam
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setPastOpen(true)}>Upload a past paper</DropdownMenuItem>
            <DropdownMenuItem disabled={!unitsWithMaterial.length} onSelect={() => setMockOpen(true)}>
              Generate a mock exam
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {papers === undefined ? (
        <Skeleton className="h-20 w-full rounded-xl" aria-label="Loading exams" />
      ) : papers.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {papers.map((paper) => (
            <PaperRow key={paper.id} paper={paper} base={base} />
          ))}
        </ul>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {unitsWithMaterial.length
            ? "No exams yet. Upload a past paper, or generate a mock exam from your units."
            : "No exams yet. Upload a past paper, or add material to a unit to generate a mock exam."}
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

/**
 * Shows one paper as a list row. Every ready paper gets the same outlined
 * Take (or Resume) button; Review moves into the row's menu.
 */
function PaperRow({ paper, base }: { paper: PaperSummary; base: string }) {
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState("")
  const href = `${base}/practice/exam/${encodeURIComponent(paper.id)}`
  const details = [
    paper.kind === "past" ? "Past paper" : "Mock exam",
    paper.status === "ready" ? plural(paper.questionCount, "question") : "",
    paper.status === "ready" && paper.totalMarks ? plural(paper.totalMarks, "mark") : "",
    paper.durationMinutes ? `${paper.durationMinutes} min` : "",
    paper.status === "ready" && paper.readFromScan ? "Scanned" : "",
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

  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium" title={paper.title}>
            {paper.title}
          </h3>
          <p className="text-xs text-muted-foreground">
            {details.join(" · ")}
            {/* The score column is hidden on narrow screens, so the best score joins the details there. */}
            {paper.status === "ready" && paper.bestPercentage !== null ? (
              <span className="sm:hidden">
                {details.length ? " · " : ""}Best {paper.bestPercentage}%
              </span>
            ) : null}
          </p>
        </div>
        {paper.status === "ready" ? (
          <span className="hidden w-20 text-right text-sm whitespace-nowrap tabular-nums sm:block">
            {paper.bestPercentage !== null ? (
              <>
                {paper.bestPercentage}%<span className="sr-only"> best score</span>
              </>
            ) : (
              <span className="text-muted-foreground">Not taken</span>
            )}
          </span>
        ) : null}
        {paper.status === "ready" ? (
          <Button asChild variant="outline" className="min-h-10 w-24 rounded-full">
            <Link href={href}>{paper.inProgressAttemptId ? "Resume" : "Take"}</Link>
          </Button>
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
          reviewHref={
            paper.status === "ready" && paper.latestAttemptId
              ? `${href}?attempt=${encodeURIComponent(paper.latestAttemptId)}`
              : undefined
          }
        />
      </div>
      {paper.status === "processing" ? (
        <p role="status" className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <LoadingIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
          {paper.kind === "past" ? "Reading the paper's questions…" : "Generating the mock exam…"}{" "}
          <ElapsedTime since={paper.runStartedAt} />
        </p>
      ) : null}
      {paper.status === "failed" && paper.error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {paper.error}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </li>
  )
}
