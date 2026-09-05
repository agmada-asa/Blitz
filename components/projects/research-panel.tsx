"use client"

/** Owns the approval-first research proposal dialog for one project. */

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { useQuery } from "convex/react"

import { useBackgroundNotice } from "@/components/background-notices"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

type ProposalStatus = "queued" | "running" | "ready" | "failed"
type ImportStatus = "queued" | "running" | "imported" | "failed"
type ResearchActivityStage =
  "queued" | "running" | "searching" | "synthesizing" | "completed" | "failed"

/** Describes one safe, persisted planning activity event. */
type ResearchActivity = {
  stage: ResearchActivityStage
  label?: string
  query?: string
  tool?: "web_search"
  occurredAt: number
  elapsedMs: number
}

/** Describes one source suggestion in a server-generated proposal. */
type ProposalSource = {
  url: string
  title: string
  reason: string
  verification: "suggested-unverified" | "checked"
}

/** Describes a proposed note outline; this dialog does not create notes. */
type PlannedNote = {
  label: "generated"
  title: string
  description: string
  reason: string
}

/** Holds the concise plan returned after a research request is prepared. */
type ResearchProposal = {
  scope: string
  topics: string[]
  sources: ProposalSource[]
  generatedNotes: PlannedNote[]
}

/** Holds the server state for one project-scoped research request. */
type ProposalSnapshot = {
  proposalId: string
  projectId: string
  requestId: string
  request: string
  status: ProposalStatus
  proposal: ResearchProposal | null
  error?: string
  activity?: ResearchActivity[]
  createdAt: number
  updatedAt: number
}

/** Holds server progress for one selected source import. */
type ResearchImport = {
  importId: string
  proposalId: string
  sourceIndex: number
  status: ImportStatus
  sourceId?: string
  sourceIds?: string[]
  partSourceIds?: string[]
  preparationJobId?: string
  failureCategory?: string
  error?: string
  createdAt: number
  updatedAt: number
}

/** Shows durable preparation progress for a downloaded research source. */
function ImportPreparationStatus({
  projectId,
  sourceIds,
}: {
  projectId: string
  sourceIds: string[]
}) {
  const boundedSourceIds = sourceIds.slice(0, 20)
  const jobs = useQuery(api.preparation.listJobsForProject, {
    projectId: projectId as Id<"projects">,
    sourceIds: boundedSourceIds as Id<"sources">[],
  })

  if (jobs === undefined || !jobs.length)
    return (
      <span className="text-white/50">Downloaded · preparation queued</span>
    )

  const failed = jobs.find((job) => job.status === "failed")
  if (failed)
    return (
      <span className="text-red-200">
        Needs retry
        <Link
          href="/notifications"
          className="ml-2 underline underline-offset-2 hover:text-white"
        >
          View preparation
        </Link>
      </span>
    )

  const active = jobs.filter(
    (job) => job.status === "queued" || job.status === "leased"
  )
  if (active.length) {
    if (sourceIds.length === 1) {
      const job = active[0]
      const currentSection = job.totalChunks
        ? Math.min(job.nextChunkOrdinal + 1, job.totalChunks)
        : undefined
      return (
        <span className="text-white/50">
          {job.status === "queued"
            ? "Queued for preparation"
            : currentSection && job.totalChunks
              ? `Preparing section ${currentSection} of ${job.totalChunks}`
              : "Preparing source…"}
        </span>
      )
    }
    return (
      <span className="text-white/50">
        {active.some((job) => job.status === "leased")
          ? "Preparing cards"
          : "Queued for preparation"}
      </span>
    )
  }

  if (sourceIds.length > 20)
    return <span className="text-white/50">Preparation continues</span>

  const completed = jobs.filter((job) => job.status === "completed")
  if (
    completed.length === sourceIds.length &&
    completed.some(
      (job) =>
        typeof job.generatedItemCount === "number" && job.generatedItemCount > 0
    )
  )
    return <span className="text-emerald-200">Ready</span>
  if (
    completed.length === sourceIds.length &&
    completed.some((job) => job.generatedItemCount === 0)
  )
    return <span className="text-amber-200">No study content</span>
  if (completed.length === sourceIds.length)
    return <span className="text-white/50">Preparation complete</span>
  return <span className="text-white/50">Preparing cards</span>
}

type ApplyState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "error"; message: string }

/** Returns a new request ID for a research request with no prior identity. */
function createRequestId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads the safe error text returned by a research route. */
async function readResearchError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

/** Merges newer import rows while retaining rows omitted by a partial response. */
function mergeImportRows(
  current: ResearchImport[],
  incoming: ResearchImport[]
): ResearchImport[] {
  const bySource = new Map(current.map((row) => [row.sourceIndex, row]))
  for (const row of incoming) {
    const previous = bySource.get(row.sourceIndex)
    if (!previous || row.updatedAt >= previous.updatedAt)
      bySource.set(row.sourceIndex, row)
  }
  return [...bySource.values()].sort(
    (left, right) => left.sourceIndex - right.sourceIndex
  )
}

/** Returns whether a source already has work that cannot be selected again. */
function isImportLocked(status: ImportStatus | undefined) {
  return status === "queued" || status === "running" || status === "imported"
}

/** Returns the short status label shown beside a source row. */
function importStatusLabel(status: ImportStatus) {
  if (status === "imported") return "Downloaded"
  if (status === "running") return "Importing…"
  if (status === "queued") return "Queued"
  return "Import failed"
}

/** Maps persisted import failure categories to concise recovery copy. */
function importFailureLabel(importRow: ResearchImport): string {
  if (importRow.failureCategory === "site-refused")
    return "The site declined access"
  if (importRow.failureCategory === "not-found") return "Source not found"
  if (importRow.failureCategory === "unsupported-format")
    return "Unsupported source format"
  if (importRow.failureCategory === "needs-ocr") return "This source needs OCR"
  if (importRow.failureCategory === "too-large") return "Source is too large"
  if (importRow.failureCategory === "timeout") return "Download timed out"
  return "Download failed"
}

/** Formats a bounded duration for a compact status line. */
function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

/** Returns the latest persisted planning event for a proposal. */
function latestActivity(activity: ResearchActivity[] | undefined) {
  return activity?.length ? activity[activity.length - 1] : undefined
}

/** Returns whether an activity stage may still be running. */
function isActiveActivityStage(stage: ResearchActivityStage): boolean {
  return (
    stage === "queued" ||
    stage === "running" ||
    stage === "searching" ||
    stage === "synthesizing"
  )
}

/** Returns elapsed planning time, including the current active interval. */
function activityElapsed(event: ResearchActivity | undefined, now: number) {
  if (!event) return 0
  return (
    event.elapsedMs +
    (isActiveActivityStage(event.stage)
      ? Math.max(0, now - event.occurredAt)
      : 0)
  )
}

/** Gives each persisted activity stage a short label suitable for the dialog. */
function activityStageLabel(stage: ResearchActivityStage): string {
  if (stage === "searching") return "Searching"
  if (stage === "synthesizing") return "Preparing sources"
  if (stage === "completed") return "Ready"
  if (stage === "failed") return "Could not prepare sources"
  if (stage === "running") return "Working"
  return "Queued"
}

/** Renders the bounded server activity trace without exposing worker internals. */
function ActivityDetails({ activity }: { activity: ResearchActivity[] }) {
  return (
    <details className="rounded-xl border border-white/10 bg-white/[0.025] px-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm text-white/70">
        Activity details
      </summary>
      <ol className="space-y-2 pb-3">
        {activity.map((event, index) => (
          <li
            key={`${event.occurredAt}-${index}`}
            className="text-xs leading-relaxed text-white/60"
          >
            <span>{event.label ?? activityStageLabel(event.stage)}</span>
            {event.query ? ` · ${event.query}` : null}
            <span className="block text-white/40">
              {formatElapsed(event.elapsedMs)}
            </span>
          </li>
        ))}
      </ol>
    </details>
  )
}

/** Props for the project-scoped research proposal entry. */
export type ResearchPanelProps = {
  projectId: string
  initialRequestId?: string
}

/** Renders the collapsed research entry and its approval dialog. */
export function ResearchPanel({
  projectId,
  initialRequestId,
}: ResearchPanelProps) {
  const [open, setOpen] = useState(Boolean(initialRequestId))
  const [requestText, setRequestText] = useState("")
  const [requestId, setRequestId] = useState<string | undefined>(
    initialRequestId
  )
  const [proposal, setProposal] = useState<ProposalSnapshot>()
  const [imports, setImports] = useState<ResearchImport[]>([])
  const [selectedSources, setSelectedSources] = useState<Set<number>>(new Set())
  const [requestPending, setRequestPending] = useState(false)
  const [requestError, setRequestError] = useState("")
  const [applyState, setApplyState] = useState<ApplyState>({ status: "idle" })
  const [retryingSourceIndex, setRetryingSourceIndex] = useState<
    number | undefined
  >(undefined)
  const [now, setNow] = useState(() => Date.now())
  const recentGeneration = useRef(0)
  const pollGeneration = useRef(0)
  const importGeneration = useRef(0)
  const projectGeneration = useRef(0)
  const selectedRequestId = useRef<string | undefined>(undefined)
  const requestIdsByText = useRef(new Map<string, string>())
  const openRef = useRef(open)
  const backgroundNoticeKeys = useRef(new Set<string>())
  const notifyBackground = useBackgroundNotice()
  const hasActiveImports = imports.some(
    (importRow) =>
      importRow.status === "queued" || importRow.status === "running"
  )

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    projectGeneration.current += 1
  }, [projectId])

  /** Stores a proposal and selects sources that have not already started importing. */
  const showProposal = useCallback((next: ProposalSnapshot | undefined) => {
    setProposal(next)
    setRequestError("")
    if (!next) {
      selectedRequestId.current = undefined
      setSelectedSources(new Set())
      return
    }
    requestIdsByText.current.set(next.request, next.requestId)
    if (next.proposal && selectedRequestId.current !== next.requestId) {
      selectedRequestId.current = next.requestId
      setSelectedSources(
        new Set(next.proposal.sources.map((_, sourceIndex) => sourceIndex))
      )
    }
  }, [])

  /** Sends one durable acknowledgement for work that continues off dialog. */
  function notifyBackgroundWork(
    key: string,
    message: string,
    href = `/projects/${encodeURIComponent(projectId)}`
  ): void {
    if (backgroundNoticeKeys.current.has(key)) return
    backgroundNoticeKeys.current.add(key)
    notifyBackground(message, href, "View project")
  }

  /** Records active research and import work when the dialog closes. */
  function notifyActiveWork(): void {
    if (
      proposal &&
      (proposal.status === "queued" || proposal.status === "running")
    )
      notifyBackgroundWork(
        `research:${proposal.requestId}`,
        "Finding sources in background"
      )
    const activeImports = imports.filter(
      (importRow) =>
        importRow.status === "queued" || importRow.status === "running"
    )
    if (activeImports.length && requestId)
      notifyBackgroundWork(
        `imports:${requestId}`,
        "Importing sources in background"
      )
  }

  /** Closes the dialog and acknowledges any persisted work that continues. */
  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) notifyActiveWork()
    setOpen(nextOpen)
  }

  useEffect(() => {
    const active =
      proposal?.status === "queued" ||
      proposal?.status === "running" ||
      hasActiveImports
    if (!active) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [hasActiveImports, proposal?.requestId, proposal?.status])

  /** Loads a deep-linked proposal or the latest project proposal after reload. */
  useEffect(() => {
    const controller = new AbortController()
    const generation = recentGeneration.current + 1
    recentGeneration.current = generation
    async function loadRecent() {
      try {
        const query = new URLSearchParams({ projectId })
        if (initialRequestId) query.set("requestId", initialRequestId)
        else query.set("limit", "5")
        const response = await fetch(`/api/research/proposals?${query}`, {
          signal: controller.signal,
        })
        if (!response.ok)
          throw new Error(
            await readResearchError(response, "Could not load research.")
          )
        const result = (await response.json()) as
          ProposalSnapshot | ProposalSnapshot[] | null
        if (recentGeneration.current !== generation) return
        const latest = Array.isArray(result) ? result[0] : (result ?? undefined)
        if (latest) {
          setRequestId(latest.requestId)
          setRequestText(latest.request)
          setImports([])
          selectedRequestId.current = undefined
          showProposal(latest)
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        if (recentGeneration.current === generation)
          setRequestError(
            error instanceof Error ? error.message : "Could not load research."
          )
      }
    }
    void loadRecent()
    return () => controller.abort()
  }, [initialRequestId, projectId, showProposal])

  /** Polls the active proposal until its server-owned state changes. */
  useEffect(() => {
    if (!requestId) return
    const activeRequestId = requestId
    const controller = new AbortController()
    const generation = pollGeneration.current + 1
    pollGeneration.current = generation
    async function poll() {
      try {
        const query = new URLSearchParams({
          projectId,
          requestId: activeRequestId,
        })
        const response = await fetch(
          `/api/research/proposals?${query.toString()}`,
          { signal: controller.signal }
        )
        if (!response.ok)
          throw new Error(
            await readResearchError(response, "Could not load research.")
          )
        const next = (await response.json()) as ProposalSnapshot | null
        if (pollGeneration.current !== generation) return
        if (next && next.requestId === activeRequestId) showProposal(next)
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        if (pollGeneration.current === generation)
          setRequestError(
            error instanceof Error ? error.message : "Could not load research."
          )
      }
    }
    void poll()
    const interval = window.setInterval(() => void poll(), 3_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [projectId, requestId, showProposal])

  /** Polls per-source import state while the current proposal is visible. */
  useEffect(() => {
    if (!requestId || proposal?.status !== "ready") return
    const activeRequestId = requestId
    const controller = new AbortController()
    const generation = importGeneration.current + 1
    importGeneration.current = generation
    async function pollImports() {
      try {
        const query = new URLSearchParams({
          projectId,
          requestId: activeRequestId,
        })
        const response = await fetch(
          `/api/research/proposals/imports?${query.toString()}`,
          { signal: controller.signal }
        )
        if (!response.ok)
          throw new Error(
            await readResearchError(response, "Could not load import status.")
          )
        const body = (await response.json()) as
          ResearchImport[] | { imports?: ResearchImport[] }
        const nextImports = Array.isArray(body) ? body : (body.imports ?? [])
        if (
          importGeneration.current !== generation ||
          requestId !== activeRequestId
        )
          return
        setImports((current) => mergeImportRows(current, nextImports))
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        if (importGeneration.current === generation)
          setRequestError(
            error instanceof Error
              ? error.message
              : "Could not load import status."
          )
      }
    }
    void pollImports()
    const interval = window.setInterval(() => void pollImports(), 3_000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [projectId, proposal?.status, requestId])

  /** Clears stale plan state before queuing a request and invalidates old responses. */
  function beginRequest(nextRequestId: string) {
    recentGeneration.current += 1
    pollGeneration.current += 1
    importGeneration.current += 1
    setRequestId(nextRequestId)
    setProposal(undefined)
    setImports([])
    selectedRequestId.current = undefined
    setSelectedSources(new Set())
    setApplyState({ status: "idle" })
    setRequestError("")
  }

  /** Queues a new proposal or safely retries the same stable request ID. */
  async function proposeSources() {
    const request = requestText.trim()
    if (!request || requestPending || applyState.status === "pending") return
    const actionProjectGeneration = projectGeneration.current
    const visibleRequestMatches =
      proposal?.requestId === requestId && proposal?.request === request
    const mappedRequestId = requestIdsByText.current.get(request)
    const stableRequestId =
      (visibleRequestMatches ? requestId : mappedRequestId) ?? createRequestId()
    requestIdsByText.current.set(request, stableRequestId)
    beginRequest(stableRequestId)
    setRequestPending(true)
    try {
      const response = await fetch("/api/research/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          requestId: stableRequestId,
          request,
        }),
      })
      if (!response.ok)
        throw new Error(
          await readResearchError(response, "Could not propose sources.")
        )
      if (projectGeneration.current !== actionProjectGeneration) return
      const next = (await response.json()) as ProposalSnapshot
      if (next.requestId !== stableRequestId) return
      showProposal(next)
      if (
        !openRef.current &&
        (next.status === "queued" || next.status === "running")
      )
        notifyBackgroundWork(
          `research:${next.requestId}`,
          "Finding sources in background"
        )
    } catch (error) {
      if (projectGeneration.current === actionProjectGeneration)
        setRequestError(
          error instanceof Error ? error.message : "Could not propose sources."
        )
    } finally {
      if (projectGeneration.current === actionProjectGeneration)
        setRequestPending(false)
    }
  }

  /** Requeues a failed proposal through its explicit retry endpoint. */
  async function retryProposal() {
    const snapshot = proposal
    const activeRequestId = snapshot?.requestId
    if (!activeRequestId || requestPending) return
    const actionProjectGeneration = projectGeneration.current
    setRequestPending(true)
    setRequestError("")
    try {
      const response = await fetch("/api/research/proposals/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, requestId: activeRequestId }),
      })
      if (!response.ok)
        throw new Error(
          await readResearchError(response, "Could not retry research.")
        )
      if (
        projectGeneration.current !== actionProjectGeneration ||
        requestId !== activeRequestId
      )
        return
      setProposal((current) =>
        current ? { ...current, status: "queued", error: undefined } : current
      )
    } catch (error) {
      if (projectGeneration.current === actionProjectGeneration)
        setRequestError(
          error instanceof Error ? error.message : "Could not retry research."
        )
    } finally {
      if (projectGeneration.current === actionProjectGeneration)
        setRequestPending(false)
    }
  }

  /** Applies only explicitly selected sources from the captured ready proposal. */
  async function importSelected() {
    const snapshot = proposal
    if (!snapshot?.proposal || snapshot.status !== "ready") return
    const activeRequestId = snapshot.requestId
    const rowsBySource = new Map(
      imports.map((importRow) => [importRow.sourceIndex, importRow])
    )
    const sourceIndexes = [...selectedSources]
      .filter(
        (sourceIndex) => !isImportLocked(rowsBySource.get(sourceIndex)?.status)
      )
      .sort((left, right) => left - right)
    if (!sourceIndexes.length || applyState.status === "pending") return
    const actionProjectGeneration = projectGeneration.current
    setApplyState({ status: "pending" })
    try {
      const response = await fetch("/api/research/proposals/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          requestId: activeRequestId,
          sourceIndexes,
        }),
      })
      if (!response.ok)
        throw new Error(
          await readResearchError(
            response,
            "Could not import selected sources."
          )
        )
      const body = (await response.json()) as {
        imports?: ResearchImport[]
      }
      if (
        projectGeneration.current !== actionProjectGeneration ||
        requestId !== activeRequestId
      )
        return
      if (body.imports)
        setImports((current) => mergeImportRows(current, body.imports ?? []))
      if (
        !openRef.current &&
        body.imports?.some(
          (row) => row.status === "queued" || row.status === "running"
        )
      )
        notifyBackgroundWork(
          `imports:${activeRequestId}`,
          "Importing sources in background"
        )
      setSelectedSources(
        (current) =>
          new Set(
            [...current].filter(
              (sourceIndex) =>
                !isImportLocked(
                  body.imports?.find((row) => row.sourceIndex === sourceIndex)
                    ?.status
                )
            )
          )
      )
      setApplyState({ status: "idle" })
    } catch (error) {
      if (projectGeneration.current === actionProjectGeneration)
        setApplyState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not import selected sources.",
        })
    }
  }

  /** Retries one failed source through the same explicit apply endpoint. */
  async function retryFailedImport(sourceIndex: number) {
    const snapshot = proposal
    if (!snapshot?.proposal || snapshot.status !== "ready") return
    const importRow = imports.find((row) => row.sourceIndex === sourceIndex)
    if (importRow?.status !== "failed" || applyState.status === "pending")
      return
    const activeRequestId = snapshot.requestId
    const actionProjectGeneration = projectGeneration.current
    setRetryingSourceIndex(sourceIndex)
    setApplyState({ status: "pending" })
    try {
      const response = await fetch("/api/research/proposals/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId,
          requestId: activeRequestId,
          sourceIndexes: [sourceIndex],
        }),
      })
      if (!response.ok)
        throw new Error(
          await readResearchError(response, "Could not retry source import.")
        )
      const body = (await response.json()) as {
        imports?: ResearchImport[]
      }
      if (
        projectGeneration.current !== actionProjectGeneration ||
        requestId !== activeRequestId
      )
        return
      if (body.imports)
        setImports((current) => mergeImportRows(current, body.imports ?? []))
      if (
        !openRef.current &&
        body.imports?.some(
          (row) => row.status === "queued" || row.status === "running"
        )
      )
        notifyBackgroundWork(
          `imports:${activeRequestId}`,
          "Importing sources in background"
        )
      setApplyState({ status: "idle" })
    } catch (error) {
      if (projectGeneration.current === actionProjectGeneration)
        setApplyState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not retry source import.",
        })
    } finally {
      if (projectGeneration.current === actionProjectGeneration)
        setRetryingSourceIndex(undefined)
    }
  }

  /** Toggles one suggested source while preserving the review selection. */
  function toggleSource(sourceIndex: number) {
    const status = imports.find(
      (row) => row.sourceIndex === sourceIndex
    )?.status
    if (isImportLocked(status)) return
    setSelectedSources((current) => {
      const next = new Set(current)
      if (next.has(sourceIndex)) next.delete(sourceIndex)
      else next.add(sourceIndex)
      return next
    })
    setApplyState({ status: "idle" })
  }

  const activeProposal =
    proposal?.status === "ready" && proposal.proposal && !requestPending
      ? proposal
      : undefined
  const activePlan = activeProposal?.proposal
  const importsBySource = new Map(
    imports.map((importRow) => [importRow.sourceIndex, importRow])
  )
  const canApply =
    activeProposal !== undefined &&
    [...selectedSources].some(
      (sourceIndex) => !isImportLocked(importsBySource.get(sourceIndex)?.status)
    ) &&
    applyState.status !== "pending"

  const latestProposalActivity = latestActivity(proposal?.activity)
  const proposalIsActive =
    proposal?.status === "queued" || proposal?.status === "running"
  const activeImports = imports.filter(
    (importRow) =>
      importRow.status === "queued" || importRow.status === "running"
  )
  const importStartedAt = activeImports.length
    ? Math.min(...activeImports.map((importRow) => importRow.createdAt))
    : undefined
  const backgroundStatus = !open
    ? proposalIsActive
      ? `Finding sources · ${formatElapsed(
          activityElapsed(latestProposalActivity, now) ||
            Math.max(0, now - (proposal?.createdAt ?? now))
        )}`
      : importStartedAt !== undefined
        ? `Importing · ${formatElapsed(Math.max(0, now - importStartedAt))}`
        : undefined
    : undefined

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(true)}
          className="h-11 rounded-full"
        >
          Find sources
        </Button>
        {backgroundStatus ? (
          <p className="text-sm text-muted-foreground" role="status">
            {backgroundStatus}
          </p>
        ) : null}
      </div>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          showCloseButton={false}
          className="flex max-h-[min(88svh,720px)] flex-col overflow-hidden border-white/10 bg-[#151515] text-white sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle className="font-sans text-white">
              Find sources
            </DialogTitle>
          </DialogHeader>

          <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1">
            <div className="space-y-3">
              <label
                htmlFor="research-request"
                className="text-sm text-white/72"
              >
                What do you want to learn?
              </label>
              <Textarea
                id="research-request"
                value={requestText}
                onChange={(event) => {
                  setRequestText(event.target.value)
                  setRequestError("")
                }}
                maxLength={2_000}
                rows={4}
                placeholder="e.g. Learn the basics of sound design"
                className="resize-none border-white/10 bg-white/[0.045] text-white placeholder:text-white/30 focus-visible:border-[#ff8065] focus-visible:ring-[#ff8065]/30"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                onClick={() => void proposeSources()}
                disabled={
                  !requestText.trim() ||
                  requestPending ||
                  applyState.status === "pending"
                }
                className="h-11 bg-[#ff8065] text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
              >
                {requestPending ? "Preparing…" : "Propose sources"}
              </Button>
              {proposal?.status === "queued" ||
              proposal?.status === "running" ? (
                <p className="text-sm text-white/50" role="status">
                  {activityStageLabel(
                    latestProposalActivity?.stage ?? proposal.status
                  )}
                  {latestProposalActivity
                    ? ` · ${formatElapsed(
                        activityElapsed(latestProposalActivity, now)
                      )}`
                    : null}
                </p>
              ) : null}
            </div>

            {requestError ? (
              <p className="text-sm text-red-200" role="alert">
                {requestError}
              </p>
            ) : null}

            {proposal?.activity?.length ? (
              <ActivityDetails activity={proposal.activity} />
            ) : null}

            {proposal?.status === "failed" ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-red-300/20 bg-red-300/5 p-3">
                <p className="text-sm text-red-200">
                  {proposal.error || "Research could not be prepared."}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void retryProposal()}
                  disabled={requestPending}
                  className="shrink-0 border-white/15 bg-transparent text-white/75 hover:bg-white/[0.07] hover:text-white"
                >
                  Retry
                </Button>
              </div>
            ) : null}

            {activeProposal && activePlan ? (
              <div className="space-y-6 border-t border-white/10 pt-5">
                <section className="space-y-2">
                  <p className="text-sm leading-relaxed text-white/65">
                    {activePlan.scope}
                  </p>
                  {activePlan.topics.length ? (
                    <p className="text-xs leading-relaxed text-white/50">
                      {activePlan.topics.join(" · ")}
                    </p>
                  ) : null}
                </section>

                <section className="space-y-3">
                  <p className="text-sm font-medium text-white">
                    Suggested sources · not checked yet
                  </p>
                  <div className="space-y-2">
                    {activePlan.sources.map((source, sourceIndex) => {
                      const importRow = importsBySource.get(sourceIndex)
                      const locked = isImportLocked(importRow?.status)
                      return (
                        <div
                          key={`${source.url}-${sourceIndex}`}
                          className="flex gap-3 rounded-xl border border-white/10 bg-white/[0.035] p-3"
                        >
                          <Checkbox
                            checked={
                              selectedSources.has(sourceIndex) && !locked
                            }
                            disabled={locked || applyState.status === "pending"}
                            onCheckedChange={() => toggleSource(sourceIndex)}
                            aria-label={`Select ${source.title}`}
                            className="mt-1 border-white/35 data-[state=checked]:border-[#ff8065] data-[state=checked]:bg-[#ff8065] data-[state=checked]:text-[#1b0d0a]"
                          />
                          <span className="min-w-0 flex-1 space-y-1">
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noreferrer"
                              className="block text-sm text-[#ffb19e] underline-offset-2 hover:underline"
                            >
                              {source.title}
                            </a>
                            <span className="block text-xs leading-relaxed text-white/55">
                              {source.reason}
                            </span>
                            {importRow ? (
                              <span
                                className={`block text-xs ${
                                  importRow.status === "failed"
                                    ? "text-red-200"
                                    : "text-white/50"
                                }`}
                                role={
                                  importRow.status === "failed"
                                    ? "alert"
                                    : "status"
                                }
                              >
                                {importRow.status === "imported"
                                  ? null
                                  : importStatusLabel(importRow.status)}
                                {importRow.status === "failed"
                                  ? `: ${importFailureLabel(importRow)}`
                                  : null}
                                {importRow.status === "imported" ? (
                                  <ImportPreparationStatus
                                    projectId={projectId}
                                    sourceIds={[
                                      ...(importRow.sourceIds ??
                                        importRow.partSourceIds ??
                                        (importRow.sourceId
                                          ? [importRow.sourceId]
                                          : [])),
                                    ]}
                                  />
                                ) : null}
                              </span>
                            ) : null}
                          </span>
                          {importRow?.status === "failed" ? (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() =>
                                void retryFailedImport(sourceIndex)
                              }
                              disabled={applyState.status === "pending"}
                              className="h-11 shrink-0 border-white/15 bg-transparent px-2 text-xs text-white/75 hover:bg-white/[0.07] hover:text-white"
                            >
                              {retryingSourceIndex === sourceIndex
                                ? "Retrying…"
                                : "Retry"}
                            </Button>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </section>

                {activePlan.generatedNotes.length ? (
                  <section className="space-y-3">
                    <h2 className="text-sm font-medium text-white">
                      Planned notes
                    </h2>
                    <ul className="space-y-3">
                      {activePlan.generatedNotes.map((note) => (
                        <li key={note.title} className="space-y-1">
                          <p className="text-sm text-white/80">{note.title}</p>
                          <p className="text-xs leading-relaxed text-white/52">
                            {note.description}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                {applyState.status === "error" ? (
                  <p className="text-sm text-red-200" role="alert">
                    {applyState.message}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <DialogFooter className="shrink-0 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              className="h-11 border-white/15 bg-transparent text-white/75 hover:bg-white/[0.07] hover:text-white"
            >
              Close
            </Button>
            {activeProposal && activePlan ? (
              <Button
                type="button"
                onClick={() => void importSelected()}
                disabled={!canApply}
                className="h-11 bg-[#ff8065] text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
              >
                {applyState.status === "pending"
                  ? "Starting…"
                  : "Import selected"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
