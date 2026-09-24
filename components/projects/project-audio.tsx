"use client"

/** Creates and plays local Kokoro audiobooks and project podcasts. */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { ProjectAudioItem } from "@/lib/project-audio-types"

/** Source metadata used to choose material for an audiobook. */
type AudioSource = {
  id: string
  filename: string
  status: "processing" | "ready" | "failed"
}

/** Props required to load and create audio for one project. */
type ProjectAudioProps = {
  projectId: string
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
export function ProjectAudio({ projectId, sources }: ProjectAudioProps) {
  const [items, setItems] = useState<ProjectAudioItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState("")
  const [durationMinutes, setDurationMinutes] =
    useState<(typeof DURATIONS)[number]>(15)
  const [focus, setFocus] = useState("")
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
      setError(null)
    },
    [apiUrl]
  )

  useEffect(() => {
    const controller = new AbortController()
    const frame = window.requestAnimationFrame(() => {
      void refresh(controller.signal)
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            setError(
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
        setError(
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
    setError(null)
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ...(kind === "audiobook"
            ? { sourceId: selectedSourceId }
            : { durationMinutes, focus: focus.trim() || undefined }),
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
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Audio could not be created."
      )
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div aria-labelledby="project-audio-heading" className="space-y-5">
      <header>
        <h2
          id="project-audio-heading"
          className="font-heading text-xl font-medium"
        >
          Listen to this project
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Kokoro speaks on this Mac using the voices saved in Settings.
        </p>
      </header>
      <div className="space-y-5">
        <section aria-labelledby="audiobook-heading" className="space-y-3">
          <h3 id="audiobook-heading" className="text-sm font-medium">
            Audiobook
          </h3>
          <p className="text-sm text-muted-foreground">
            Turn one ready source into narrated audio.
          </p>
          {readySources.length ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={selectedSourceId} onValueChange={setSourceId}>
                <SelectTrigger
                  aria-label="Source for audiobook"
                  className="min-h-10 flex-1"
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
              <Button
                className="min-h-10"
                disabled={
                  submitting !== null || hasActiveJobs || !selectedSourceId
                }
                onClick={() => void createAudio("audiobook")}
              >
                {submitting === "audiobook" ? "Starting…" : "Create audiobook"}
              </Button>
            </div>
          ) : (
            <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
              Add a ready source to create an audiobook.
            </p>
          )}
        </section>

        <section
          aria-labelledby="podcast-heading"
          className="space-y-3 border-t border-border/70 pt-5"
        >
          <h3 id="podcast-heading" className="text-sm font-medium">
            Project podcast
          </h3>
          <p className="text-sm text-muted-foreground">
            Your Research model writes from project sources, then Kokoro speaks
            the episode. Longer episodes take more time and may use more model
            credits.
          </p>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <label className="space-y-1.5 text-sm">
              <span>Episode length</span>
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
            <span className="hidden sm:block" aria-hidden="true" />
          </div>
          <label className="block space-y-1.5 text-sm">
            <span>
              What should the hosts focus on?{" "}
              <span className="text-muted-foreground">(optional)</span>
            </span>
            <Textarea
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              maxLength={500}
              placeholder="For example, explain the key ideas and how they connect."
              className="min-h-20"
            />
          </label>
          <Button
            className="min-h-10 w-full sm:w-auto"
            disabled={
              submitting !== null || hasActiveJobs || !readySources.length
            }
            onClick={() => void createAudio("podcast")}
          >
            {submitting === "podcast" ? "Starting…" : "Create podcast"}
          </Button>
        </section>

        <section
          aria-labelledby="audio-library-heading"
          className="space-y-3 border-t border-border/70 pt-5"
        >
          <h3 id="audio-library-heading" className="text-sm font-medium">
            Your audio
          </h3>
          {loading ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading audio…
            </p>
          ) : null}
          {!loading && !items.length && !error ? (
            <p className="text-sm text-muted-foreground">
              Your audiobooks and podcasts will appear here.
            </p>
          ) : null}
          {items.map((item) => (
            <article
              key={item.id}
              className="space-y-2 rounded-lg border border-border/70 p-3"
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-medium">{item.title}</h4>
                  <p className="text-xs text-muted-foreground">
                    {item.kind === "audiobook"
                      ? "Audiobook"
                      : `Podcast${item.durationMinutes ? ` · ${Math.round(item.durationMinutes)} min` : ""}`}
                    {formatCreatedAt(item.createdAt)
                      ? ` · ${formatCreatedAt(item.createdAt)}`
                      : ""}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {generationLabel(item)}
                </span>
              </div>
              {item.error ? (
                <p className="text-sm text-destructive">{item.error}</p>
              ) : null}
              {item.audioUrl && item.status === "completed" ? (
                <div className="space-y-2">
                  <audio
                    className="w-full"
                    controls
                    preload="none"
                    src={item.audioUrl}
                  >
                    Your browser does not support audio playback.
                  </audio>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button asChild variant="outline" size="sm">
                      <Link
                        href={`/projects/${encodeURIComponent(projectId)}/listen/${item.id}`}
                      >
                        Open listening room
                      </Link>
                    </Button>
                    <a
                      className="text-sm font-medium text-brand underline-offset-4 hover:underline"
                      href={`${item.audioUrl}?download=1`}
                      download
                    >
                      Download audio
                    </a>
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </section>
        {error ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="text-sm text-destructive">{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setLoading(true)
                void refresh()
                  .catch((cause: unknown) =>
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Audio could not be loaded."
                    )
                  )
                  .finally(() => setLoading(false))
              }}
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
