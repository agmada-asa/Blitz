"use client"

/** Manages project audiobook and podcast creation, status, and playback. */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useQuery } from "convex/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ProjectAudioItem } from "@/lib/project-audio-types"

/** Select value for a podcast covering the whole module. */
const WHOLE_MODULE = "module"

/** Source metadata used to choose material for an audiobook. */
type AudioSource = {
  id: string
  filename: string
  status: "processing" | "ready" | "failed"
}

/** Props required to load and create audio for one project. */
type ProjectAudioProps = {
  projectId: string
  projectTitle?: string
  sources: AudioSource[]
}

const DURATIONS = [15, 30, 60, 90] as const

/** Returns a human readable status for audio generation state. */
function statusLabel(status: string): string {
  if (status === "queued" || status === "pending") return "Waiting to start"
  if (status === "processing" || status === "generating") return "Generating"
  if (status === "completed" || status === "ready") return "Ready"
  if (status === "failed" || status === "error") return "Failed"
  return status
}

/** Names the active step and shows progress through speech synthesis. */
function generationLabel(item: ProjectAudioItem): string {
  if (item.status !== "generating") return statusLabel(item.status)
  if (item.stage === "preparing") return "Preparing source"
  if (item.stage === "adapting") return "Preparing narration"
  if (item.stage === "writing") return "Writing script"
  if (item.stage === "finishing") return "Finishing audio"
  if (item.stage === "recording") {
    const progress =
      item.totalChunks && item.completedChunks !== undefined
        ? ` ${Math.round((item.completedChunks / item.totalChunks) * 100)}%`
        : ""
    return `Recording${progress}`
  }
  return "Generating"
}

/** Formats a creation timestamp without assuming the API's date representation. */
function formatCreatedAt(createdAt: number): string {
  const timestamp = createdAt
  if (!Number.isFinite(timestamp)) return ""
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    timestamp
  )
}

/** Loads project audio, creates requests, and presents playback and download links. */
export function ProjectAudio({
  projectId,
  projectTitle = "Project",
  sources,
}: ProjectAudioProps) {
  const [items, setItems] = useState<ProjectAudioItem[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState("")
  const [durationMinutes, setDurationMinutes] =
    useState<(typeof DURATIONS)[number]>(15)
  const [focus, setFocus] = useState("")
  const [podcastScope, setPodcastScope] = useState(WHOLE_MODULE)
  const unitData = useQuery(api.units.listForProject, {
    projectId: projectId as Id<"projects">,
  })
  // Only units with readable material can be covered by a podcast.
  const podcastUnits = (unitData?.units ?? []).filter((unit) =>
    unit.sources.some((source) => source.hasText)
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [submitting, setSubmitting] = useState<"audiobook" | "podcast" | null>(
    null
  )
  const readySources = useMemo(
    () => sources.filter((source) => source.status === "ready"),
    [sources]
  )
  const selectedSourceId = sourceId || readySources[0]?.id || ""
  const apiUrl = `/api/projects/${encodeURIComponent(projectId)}/audio`

  /** Fetches the current audio list and keeps generation status current. */
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(apiUrl, { signal, cache: "no-store" })
      const payload = (await response.json()) as {
        items?: ProjectAudioItem[]
        error?: string
      }
      if (!response.ok)
        throw new Error(payload.error || "Audio could not be loaded.")
      setItems(payload.items ?? [])
      setLoadError(null)
    },
    [apiUrl]
  )

  useEffect(() => {
    const controller = new AbortController()
    const frame = window.requestAnimationFrame(() => {
      void refresh(controller.signal)
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setLoadError(
              cause instanceof Error
                ? cause.message
                : "Audio could not be loaded."
            )
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      controller.abort()
    }
  }, [refresh])

  const hasActiveJobs = items.some((item) =>
    ["queued", "pending", "processing", "generating"].includes(item.status)
  )
  useEffect(() => {
    if (!hasActiveJobs) return
    const timer = window.setInterval(() => {
      void refresh().catch((cause: unknown) =>
        setLoadError(
          cause instanceof Error
            ? cause.message
            : "Audio status could not be refreshed."
        )
      )
    }, 5000)
    return () => window.clearInterval(timer)
  }, [hasActiveJobs, refresh])

  /** Submits a project audio generation request and refreshes the visible list. */
  async function createAudio(kind: "audiobook" | "podcast"): Promise<void> {
    setSubmitting(kind)
    setCreateError(null)
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ...(kind === "audiobook"
            ? { sourceId: selectedSourceId }
            : {
                durationMinutes,
                focus: focus.trim() || undefined,
                ...(podcastScope !== WHOLE_MODULE ? { unitId: podcastScope } : {}),
              }),
        }),
      })
      const payload = (await response.json()) as {
        item?: ProjectAudioItem
        error?: string
      }
      if (!response.ok || !payload.item)
        throw new Error(payload.error || "Audio could not be created.")
      setItems((current) => [
        payload.item!,
        ...current.filter((item) => item.id !== payload.item!.id),
      ])
      if (kind === "podcast") setFocus("")
      setCreateOpen(false)
    } catch (cause) {
      setCreateError(
        cause instanceof Error ? cause.message : "Audio could not be created."
      )
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 py-6 pb-32 sm:px-8 sm:py-8">
      <header className="space-y-3">
        <Button asChild variant="ghost" size="sm" className="-ml-3 min-h-9">
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>
            ← {projectTitle}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-heading text-3xl font-medium tracking-tight">
            Listen
          </h1>
          <Button
            type="button"
            variant="outline"
            className="min-h-10"
            onClick={() => {
              setCreateError(null)
              setCreateOpen(true)
            }}
          >
            Create recording
          </Button>
        </div>
      </header>

      <section aria-labelledby="audio-library-heading" className="space-y-3">
        <h2
          id="audio-library-heading"
          className="font-heading text-xl font-medium"
        >
          Your recordings
        </h2>
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading recordings…
          </p>
        ) : null}
        {!loading && !items.length && !loadError ? (
          <p className="text-sm text-muted-foreground">No recordings yet.</p>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <article
              key={item.id}
              className="flex aspect-square min-w-0 flex-col justify-between gap-4 rounded-xl border border-border/70 bg-card p-4 sm:p-5"
            >
              <div className="space-y-3">
                <div className="min-w-0">
                  <h3 className="line-clamp-3 font-heading text-lg font-medium break-words">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.kind === "audiobook" ? "Audiobook" : "Podcast"}
                    {item.durationMinutes
                      ? ` · ${Math.round(item.durationMinutes)} min`
                      : ""}
                    {formatCreatedAt(item.createdAt)
                      ? ` · ${formatCreatedAt(item.createdAt)}`
                      : ""}
                  </p>
                </div>
                <span className="text-sm text-muted-foreground" role="status">
                  {generationLabel(item)}
                </span>
                {item.error ? (
                  <p
                    className="line-clamp-3 text-sm text-destructive"
                    role="alert"
                  >
                    {item.error}
                  </p>
                ) : null}
              </div>
              {item.status === "completed" && item.audioUrl ? (
                <div className="flex flex-col gap-2">
                  <Button asChild className="min-h-10 w-full">
                    <Link
                      href={`/projects/${encodeURIComponent(projectId)}/listen/${encodeURIComponent(item.id)}`}
                    >
                      Listen
                    </Link>
                  </Button>
                  <a
                    className="min-h-9 content-center text-center text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
                    href={`${item.audioUrl}?download=1`}
                    download
                  >
                    Download audio
                  </a>
                </div>
              ) : null}
            </article>
          ))}
        </div>
        {loadError ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true)
                void refresh()
                  .catch((cause: unknown) =>
                    setLoadError(
                      cause instanceof Error
                        ? cause.message
                        : "Audio could not be loaded."
                    )
                  )
                  .finally(() => setLoading(false))
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </section>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create recording</DialogTitle>
          </DialogHeader>
          <Tabs defaultValue="audiobook" className="items-start">
            <TabsList className="w-full max-w-sm">
              <TabsTrigger value="audiobook" className="flex-1">
                Audiobook
              </TabsTrigger>
              <TabsTrigger value="podcast" className="flex-1">
                Podcast
              </TabsTrigger>
            </TabsList>
            <TabsContent value="audiobook" className="w-full">
              <div className="space-y-3">
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Source</span>
                  {readySources.length ? (
                    <Select
                      value={selectedSourceId}
                      onValueChange={setSourceId}
                    >
                      <SelectTrigger
                        aria-label="Source for audiobook"
                        className="min-h-10"
                      >
                        <SelectValue placeholder="Choose a source" />
                      </SelectTrigger>
                      <SelectContent>
                        {readySources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.filename}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Select disabled>
                      <SelectTrigger
                        aria-label="Source for audiobook"
                        className="min-h-10"
                      >
                        <SelectValue placeholder="Choose a source" />
                      </SelectTrigger>
                    </Select>
                  )}
                </label>
                <Button
                  className="min-h-10 w-full"
                  disabled={
                    submitting !== null || hasActiveJobs || !selectedSourceId
                  }
                  onClick={() => void createAudio("audiobook")}
                >
                  {submitting === "audiobook"
                    ? "Starting…"
                    : "Create audiobook"}
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="podcast" className="w-full">
              <div className="space-y-3">
                {podcastUnits.length ? (
                  <label className="block space-y-1.5 text-sm">
                    <span className="font-medium">Covers</span>
                    <Select value={podcastScope} onValueChange={setPodcastScope}>
                      <SelectTrigger aria-label="What the podcast covers" className="min-h-10 w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={WHOLE_MODULE}>The whole module</SelectItem>
                        {podcastUnits.map((unit) => (
                          <SelectItem key={unit.id} value={unit.id}>
                            {unit.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                ) : null}
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">Episode length</span>
                  <Select
                    value={String(durationMinutes)}
                    onValueChange={(value) =>
                      setDurationMinutes(
                        Number(value) as (typeof DURATIONS)[number]
                      )
                    }
                  >
                    <SelectTrigger
                      aria-label="Podcast episode length"
                      className="min-h-10"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DURATIONS.map((duration) => (
                        <SelectItem key={duration} value={String(duration)}>
                          {duration} minutes
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="block space-y-1.5 text-sm">
                  <span className="font-medium">
                    Focus{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </span>
                  <Textarea
                    value={focus}
                    onChange={(event) => setFocus(event.target.value)}
                    maxLength={500}
                    placeholder="What should the hosts focus on?"
                    className="min-h-20"
                  />
                </label>
                <Button
                  className="min-h-10 w-full"
                  disabled={
                    submitting !== null || hasActiveJobs || !readySources.length
                  }
                  onClick={() => void createAudio("podcast")}
                >
                  {submitting === "podcast" ? "Starting…" : "Create podcast"}
                </Button>
              </div>
            </TabsContent>
          </Tabs>
          {!readySources.length ? (
            <p className="text-sm text-muted-foreground">
              Add a ready source in the{" "}
              <Link
                className="font-medium text-brand underline-offset-4 hover:underline"
                href={`/projects/${encodeURIComponent(projectId)}`}
              >
                project overview
              </Link>{" "}
              to create a recording.
            </p>
          ) : null}
          {hasActiveJobs ? (
            <p className="text-sm text-muted-foreground" role="status">
              Finish the current recording before starting another.
            </p>
          ) : null}
          {createError ? (
            <p role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </main>
  )
}
