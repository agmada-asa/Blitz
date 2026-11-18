"use client"

/**
 * Connects a module's sources, their management actions, and source research
 * in one page. The file list fills the page; research opens from the
 * "Ask Blitz to find sources" button in a dialog.
 */

import Link from "next/link"
import { useEffect, useState } from "react"
import { useQuery } from "convex/react"
import { AddMaterial } from "@/components/learn/add-material"
import { PageContainer } from "@/components/page-container"
import { ProjectFiles } from "@/components/projects/project-files"
import { ResearchPanel } from "@/components/projects/research-panel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ArrowLeftIcon, PlusIcon, SparklesIcon } from "@/components/ui/icon"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {} from "@/lib/client/desktop"

/** Props for the Sources route after its promise based parameters are resolved. */
type ProjectSourcesWorkspaceProps = {
  projectId: string
  initialResearchRequestId?: string
  /** Unit the learner opened Find sources from, picked for imports by default. */
  initialResearchUnitId?: string
}

/** Shows current project sources, existing add methods, and source detail previews. */
export function ProjectSourcesWorkspace({
  projectId,
  initialResearchRequestId,
  initialResearchUnitId,
}: ProjectSourcesWorkspaceProps) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const managedSources = useQuery(api.sources.listForManager, {
    projectId: convexProjectId,
  })
  const sources = managedSources ?? []
  const unitData = useQuery(api.units.listForProject, {
    projectId: convexProjectId,
  })
  const [adding, setAdding] = useState(false)
  // Links from a unit's Find sources or a research notification open research straight away.
  const [researchOpen, setResearchOpen] = useState(
    Boolean(initialResearchRequestId || initialResearchUnitId)
  )
  const [agentWorkspaceDirectory, setAgentWorkspaceDirectory] = useState("")
  const [desktopAvailable, setDesktopAvailable] = useState(false)
  const ingestion = useQuery(api.projectAgents.listIngestion, {
    projectId: convexProjectId,
  })
  const preparation = useQuery(api.preparation.listJobsForProject, {
    projectId: convexProjectId,
    sourceIds: sources.map((source) => source._id),
  })
  const artifacts = useQuery(api.projectAgents.listArtifacts, {
    projectId: convexProjectId,
  })

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) setDesktopAvailable(Boolean(window.blitzDesktop))
    })
    fetch(`/api/projects/${encodeURIComponent(projectId)}/agent`)
      .then(
        async (response) =>
          (await response.json()) as { workspaceDirectory?: string }
      )
      .then((result) => {
        if (active) setAgentWorkspaceDirectory(result.workspaceDirectory ?? "")
      })
      .catch(() => {
        if (active) setAgentWorkspaceDirectory("")
      })
    return () => {
      active = false
    }
  }, [projectId])

  /** Opens one generated file through the project's existing artifact endpoint. */
  function openArtifact(artifact: { relativeKey: string }): void {
    if (window.blitzDesktop) {
      const absolutePath = agentWorkspaceDirectory
        ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${artifact.relativeKey}`
        : artifact.relativeKey
      void window.blitzDesktop.openFile(projectId, absolutePath)
      return
    }
    window.open(
      `/api/projects/${encodeURIComponent(projectId)}/agent/artifacts?key=${encodeURIComponent(artifact.relativeKey)}`,
      "_blank",
      "noopener,noreferrer"
    )
  }

  /** Reveals one generated artifact in the desktop file browser when available. */
  function revealArtifact(artifact: { relativeKey: string }): void {
    if (!window.blitzDesktop) return
    const absolutePath = agentWorkspaceDirectory
      ? `${agentWorkspaceDirectory.replace(/[\\/]$/, "")}/${artifact.relativeKey}`
      : artifact.relativeKey
    void window.blitzDesktop.revealFile(projectId, absolutePath)
  }

  /** Adds one project artifact through the existing explicit promotion endpoint. */
  async function addArtifactToSources(artifact: {
    relativeKey: string
  }): Promise<void> {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/agent/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ relativeKey: artifact.relativeKey }),
      }
    )
    const payload = (await response.json()) as { error?: string }
    if (!response.ok)
      throw new Error(payload.error || "File could not be added to sources.")
  }

  /** Retries source ingestion through the existing project-scoped recovery route. */
  async function retrySource(sourceId: string): Promise<void> {
    const response = await fetch("/api/sources/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, sourceId }),
    })
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string }
      throw new Error(payload.error || "Source retry failed.")
    }
  }

  if (project === undefined) return <SourcesLoadingState />
  if (!project) return <SourcesNotFoundState />

  const preparationJobs = preparation?.map((job) => ({
    jobId: String(job.jobId),
    sourceId: String(job.sourceId),
    status: job.status,
    error: job.error ?? undefined,
    nextChunkOrdinal: job.nextChunkOrdinal,
    totalChunks: job.totalChunks ?? undefined,
    generatedItemCount: job.generatedItemCount ?? undefined,
    leaseExpired: job.leaseExpired,
  }))

  const unitOptions = (unitData?.units ?? []).map((unit) => ({
    id: unit.id,
    title: unit.title,
  }))
  const unitCount = unitOptions.length

  return (
    <PageContainer className="space-y-6">
      <header className="space-y-3">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-3 min-h-9 max-w-full text-muted-foreground"
        >
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            <span className="truncate">{project.title}</span>
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="font-heading text-3xl font-medium tracking-tight">
              Sources
            </h1>
            {managedSources?.length ? (
              <p className="mt-1 text-sm text-pretty text-muted-foreground">
                {managedSources.length}{" "}
                {managedSources.length === 1 ? "file" : "files"}
                {unitCount
                  ? ` across ${unitCount} ${unitCount === 1 ? "unit" : "units"}`
                  : ""}
                . Open one to read the original.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setResearchOpen(true)}
              className="min-h-10"
            >
              <SparklesIcon aria-hidden="true" className="size-4" />
              Ask Blitz to find sources
            </Button>
            <Button
              type="button"
              onClick={() => setAdding(true)}
              className="min-h-10"
            >
              <PlusIcon aria-hidden="true" className="size-4" />
              Add material
            </Button>
          </div>
        </div>
      </header>

      <div className="min-w-0">
        <section className="min-w-0" aria-label="Project sources">
          {managedSources === undefined ? (
            <p className="py-5 text-sm text-muted-foreground" role="status">
              Loading sources…
            </p>
          ) : (
            <ProjectFiles
              projectId={convexProjectId}
              sources={sources}
              units={(unitData?.units ?? []).map((unit) => ({
                id: unit.id,
                title: unit.title,
              }))}
              ingestion={ingestion?.map((job) => ({
                sourceId: String(job.sourceId),
                status: job.status,
                error: job.error,
              }))}
              preparation={preparationJobs}
              artifacts={artifacts?.map((artifact) => ({
                id: String(artifact._id),
                relativeKey: artifact.relativeKey,
                kind: artifact.kind,
                mimeType: artifact.mimeType,
                sizeBytes: artifact.sizeBytes,
                status: artifact.status,
                updatedAt: artifact.updatedAt,
              }))}
              actions={{
                onOpenArtifact: openArtifact,
                onRevealArtifact: desktopAvailable ? revealArtifact : undefined,
                onOpenCreatedFilesFolder:
                  desktopAvailable && agentWorkspaceDirectory
                    ? () =>
                        void window.blitzDesktop?.openFile(
                          projectId,
                          agentWorkspaceDirectory
                        )
                    : undefined,
                onAddArtifactToSources: addArtifactToSources,
                onRetryIngestion: retrySource,
              }}
            />
          )}
        </section>
      </div>

      {/* Research lives in a dialog so the file list keeps the page. The panel
          reloads the latest request whenever it opens, so closing it never
          loses research in progress. */}
      <Dialog open={researchOpen} onOpenChange={setResearchOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Ask Blitz to find sources</DialogTitle>
            <DialogDescription>
              Describe what you want to learn. Blitz suggests sources to add,
              and you choose which ones go into the module.
            </DialogDescription>
          </DialogHeader>
          <ResearchPanel
            projectId={String(projectId)}
            initialRequestId={initialResearchRequestId}
            active={researchOpen}
            units={unitOptions.map((unit) => ({
              id: String(unit.id),
              title: unit.title,
            }))}
            {...(initialResearchUnitId
              ? { defaultUnitId: initialResearchUnitId }
              : {})}
          />
        </DialogContent>
      </Dialog>
      {adding ? (
        <AddMaterial
          projectId={convexProjectId}
          units={unitOptions}
          open
          onOpenChange={(open) => {
            if (!open) setAdding(false)
          }}
        />
      ) : null}
    </PageContainer>
  )
}

/** Keeps source navigation visible while the project query is pending. */
function SourcesLoadingState() {
  return (
    <PageContainer>
      <div role="status" aria-label="Loading sources" className="space-y-5">
        <span className="sr-only">Loading sources</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    </PageContainer>
  )
}

/** Offers a simple return path when the requested project no longer exists. */
function SourcesNotFoundState() {
  return (
    <main className="mx-auto flex min-h-[55svh] max-w-3xl flex-col items-center justify-center px-5 text-center">
      <div role="alert">
        <h1 className="font-heading text-2xl font-semibold">
          Project not found
        </h1>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/">Back to projects</Link>
        </Button>
      </div>
    </main>
  )
}
