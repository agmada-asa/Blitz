"use client"

/**
 * Owns the project research proposal and source selection flow. Approved
 * sources are imported into the unit the learner picks, or a new unit for the
 * research, ready to teach.
 */

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"

import { useBackgroundNotice } from "@/components/background-notices"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

/** Value of the unit picker that files imports into a new unit for this research. */
const NEW_UNIT = "new"

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

/** Describes a proposed note outline; this panel does not create notes. */
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
  /** Unit the sources were filed into; absent on imports from before units. */
  unitId?: string
  createdAt: number
  updatedAt: number
}

/** A unit the learner can file imported sources into. */
export type ResearchUnitOption = { id: string; title: string }

/**
 * Confirms where an imported source went and offers to start learning it.
 * Imports from before units existed only say they were imported.
 */
function ImportedStatus({
  projectId,
  unitId,
  units,
}: {
  projectId: string
  unitId?: string
  units: ResearchUnitOption[]
}) {
  const unit = units.find((item) => item.id === unitId)
  if (!unitId || !unit)
    return <span className="text-muted-foreground">Imported</span>
  return (
    <span className="text-muted-foreground">
      Added to {unit.title}
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/learn/${encodeURIComponent(unitId)}`}
        className="ml-2 text-foreground underline underline-offset-2"
      >
        Start learning
      </Link>
    </span>
  )
}

/** Request state for importing or retrying selected sources. */
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

/** Gives each persisted activity stage a short status label. */
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
    <details className="rounded-xl border border-border bg-muted/30 px-3">
      <summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted-foreground">
        Activity details
      </summary>
      <ol className="space-y-2 pb-3">
        {activity.map((event, index) => (
          <li
            key={`${event.occurredAt}-${index}`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            <span>{event.label ?? activityStageLabel(event.stage)}</span>
            {event.query ? ` · ${event.query}` : null}
            <span className="block text-muted-foreground/70">
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
  active: boolean
  /** The module's units, in path order, offered as import destinations. */
  units: ResearchUnitOption[]
  /** Unit the learner is researching for, picked by default. */
  defaultUnitId?: string
}

/** Renders the research request and source review inside Add sources. */
export function ResearchPanel({
  projectId,
  initialRequestId,
  active,
  units,
  defaultUnitId,
}: ResearchPanelProps) {
  const [unitTarget, setUnitTarget] = useState(defaultUnitId ?? NEW_UNIT)
  // A unit deleted since it was picked falls back to a new unit.
  const target = units.some((unit) => unit.id === unitTarget)
    ? unitTarget
    : NEW_UNIT
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
  const activeRef = useRef(active)
  const backgroundNoticeKeys = useRef(new Set<string>())
  const notifyBackground = useBackgroundNotice()
  const hasActiveImports = imports.some(
    (importRow) =>
      importRow.status === "queued" || importRow.status === "running"
  )

  useEffect(() => {
    activeRef.current = active
  }, [active])

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

  /** Sends one durable acknowledgement for work that continues off tab. */
  function notifyBackgroundWork(
    key: string,
    message: string,
    href = `/projects/${encodeURIComponent(projectId)}`
  ): void {
    if (backgroundNoticeKeys.current.has(key)) return
    backgroundNoticeKeys.current.add(key)
    notifyBackground(message, href, "View project")
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
        !activeRef.current &&
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
          ...(target === NEW_UNIT ? {} : { unitId: target }),
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
        !activeRef.current &&
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
          ...(target === NEW_UNIT ? {} : { unitId: target }),
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
        !activeRef.current &&
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

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-3">
        <label htmlFor="research-request" className="text-sm text-foreground">
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
          className="resize-none"
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
          className="h-11 bg-brand text-brand-foreground hover:bg-brand/85"
        >
          {requestPending ? "Searching…" : "Find sources"}
        </Button>
        {proposal?.status === "queued" || proposal?.status === "running" ? (
          <p className="text-sm text-muted-foreground" role="status">
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
        <p className="text-sm text-destructive" role="alert">
          {requestError}
        </p>
      ) : null}

      {proposal?.activity?.length ? (
        <ActivityDetails activity={proposal.activity} />
      ) : null}

      {proposal?.status === "failed" ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3">
          <p className="text-sm text-destructive">
            {proposal.error || "Research could not be prepared."}
          </p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void retryProposal()}
            disabled={requestPending}
            className="shrink-0"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {activeProposal && activePlan ? (
        <div className="space-y-6 border-t border-border pt-5">
          <section className="space-y-2">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {activePlan.scope}
            </p>
            {activePlan.topics.length ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {activePlan.topics.join(" · ")}
              </p>
            ) : null}
          </section>

          <section className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              Suggested sources
            </p>
            <div className="space-y-2">
              {activePlan.sources.map((source, sourceIndex) => {
                const importRow = importsBySource.get(sourceIndex)
                const locked = isImportLocked(importRow?.status)
                return (
                  <div
                    key={`${source.url}-${sourceIndex}`}
                    className="flex gap-3 rounded-xl border border-border bg-muted/30 p-3"
                  >
                    <Checkbox
                      checked={selectedSources.has(sourceIndex) && !locked}
                      disabled={locked || applyState.status === "pending"}
                      onCheckedChange={() => toggleSource(sourceIndex)}
                      aria-label={`Select ${source.title}`}
                      className="mt-1 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground"
                    />
                    <span className="min-w-0 flex-1 space-y-1">
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block text-sm text-foreground underline-offset-2 hover:underline"
                      >
                        {source.title}
                      </a>
                      <span className="block text-xs leading-relaxed text-muted-foreground">
                        {source.reason}
                      </span>
                      {importRow ? (
                        <span
                          className={`block text-xs ${
                            importRow.status === "failed"
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                          role={
                            importRow.status === "failed" ? "alert" : "status"
                          }
                        >
                          {importRow.status === "imported"
                            ? null
                            : importStatusLabel(importRow.status)}
                          {importRow.status === "failed"
                            ? `: ${importFailureLabel(importRow)}`
                            : null}
                          {importRow.status === "imported" ? (
                            <ImportedStatus
                              projectId={projectId}
                              unitId={importRow.unitId}
                              units={units}
                            />
                          ) : null}
                        </span>
                      ) : null}
                    </span>
                    {importRow?.status === "failed" ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void retryFailedImport(sourceIndex)}
                        disabled={applyState.status === "pending"}
                        className="h-11 shrink-0 px-2 text-xs"
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
              <h3 className="text-sm font-medium text-foreground">
                Planned notes
              </h3>
              <ul className="space-y-3">
                {activePlan.generatedNotes.map((note) => (
                  <li key={note.title} className="space-y-1">
                    <p className="text-sm text-foreground">{note.title}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {note.description}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {applyState.status === "error" ? (
            <p className="text-sm text-destructive" role="alert">
              {applyState.message}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-1.5">
              <label
                htmlFor="research-unit"
                className="text-sm font-medium text-foreground"
              >
                Add to
              </label>
              <Select
                value={target}
                onValueChange={setUnitTarget}
                disabled={applyState.status === "pending"}
              >
                <SelectTrigger id="research-unit" className="min-h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NEW_UNIT}>New unit</SelectItem>
                  {units.map((unit) => (
                    <SelectItem key={unit.id} value={unit.id}>
                      {unit.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => void importSelected()}
              disabled={!canApply}
              className="h-11 shrink-0 bg-brand text-brand-foreground hover:bg-brand/85"
            >
              {applyState.status === "pending"
                ? "Starting…"
                : "Import selected"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
