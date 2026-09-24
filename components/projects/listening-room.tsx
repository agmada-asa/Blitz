"use client"

/** Plays a project recording with timed passages and a focused question dialog. */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Markdown } from "@/components/ui/markdown"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import type {
  ProjectAudioItem,
  ProjectAudioSegment,
  ProjectAudioTranscript,
} from "@/lib/project-audio-types"
import { cn } from "@/lib/utils"

/** Props identify one completed local recording inside its owning project. */
type ListeningRoomProps = { projectId: string; audioId: string }
/** Lightweight conversation retained while the selected-passage dialog is open. */
type ListeningMessage = { role: "user" | "assistant"; text: string }

/** Formats a measured playback time as minutes or hours and minutes. */
function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remaining = whole % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`
}

/** Finds the passage containing the player's current position. */
function passageAtTime(
  segments: ProjectAudioSegment[],
  seconds: number
): number {
  let left = 0
  let right = segments.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    if (seconds < segments[middle].startSeconds) right = middle - 1
    else if (seconds >= segments[middle].endSeconds) left = middle + 1
    else return middle
  }
  return Math.max(0, Math.min(left, segments.length - 1))
}

/** Names the speaker only when the recording uses distinct podcast hosts. */
function speakerLabel(segment: ProjectAudioSegment): string {
  if (segment.speaker === "host1") return "Host 1"
  if (segment.speaker === "host2") return "Host 2"
  return "Narrator"
}

/** Fetches a completed transcript, follows playback, and manages selected text chat. */
export function ListeningRoom({ projectId, audioId }: ListeningRoomProps) {
  const [recording, setRecording] = useState<{
    item: ProjectAudioItem
    transcript: ProjectAudioTranscript
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [followAlong, setFollowAlong] = useState(true)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(
    () => new Set()
  )
  const [askOpen, setAskOpen] = useState(false)
  const [askIndices, setAskIndices] = useState<number[]>([])
  const [question, setQuestion] = useState("")
  const [messages, setMessages] = useState<ListeningMessage[]>([])
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const passageRefs = useRef<Array<HTMLDivElement | null>>([])
  const baseUrl = `/api/projects/${encodeURIComponent(projectId)}/audio/${encodeURIComponent(audioId)}`

  /** Loads the server-validated transcript and supports a retry after failure. */
  const loadRecording = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError(null)
      try {
        const response = await fetch(`${baseUrl}/transcript`, {
          signal,
          cache: "no-store",
        })
        const payload = (await response.json()) as {
          item?: ProjectAudioItem
          transcript?: ProjectAudioTranscript
          error?: string
        }
        if (!response.ok || !payload.item || !payload.transcript)
          throw new Error(
            payload.error || "This recording could not be loaded."
          )
        if (!signal?.aborted)
          setRecording({ item: payload.item, transcript: payload.transcript })
      } catch (cause) {
        if (!signal?.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "This recording could not be loaded."
          )
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [baseUrl]
  )

  useEffect(() => {
    const controller = new AbortController()
    const frame = window.requestAnimationFrame(() => {
      void loadRecording(controller.signal)
    })
    return () => {
      window.cancelAnimationFrame(frame)
      controller.abort()
    }
  }, [loadRecording])

  const segments = recording?.transcript.segments ?? []
  const activeIndex = segments.length
    ? passageAtTime(segments, currentTime)
    : -1
  const selection = useMemo(
    () => [...selectedIndices].sort((left, right) => left - right),
    [selectedIndices]
  )

  useEffect(() => {
    if (!followAlong || activeIndex < 0) return
    const container = transcriptRef.current
    const passage = passageRefs.current[activeIndex]
    if (!container || !passage) return
    const top =
      passage.offsetTop - container.clientHeight / 2 + passage.clientHeight / 2
    container.scrollTo({
      top,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    })
  }, [activeIndex, followAlong])

  /** Starts playback from the selected measured passage. */
  function seekTo(index: number): void {
    const audio = audioRef.current
    if (!audio || !segments[index]) return
    audio.currentTime = segments[index].startSeconds
    setCurrentTime(audio.currentTime)
    void audio.play().catch(() => {
      // Native controls remain available when the browser declines autoplay.
    })
  }

  /** Adds or removes one passage without changing playback. */
  function togglePassage(index: number, checked: boolean): void {
    setSelectedIndices((current) => {
      const next = new Set(current)
      if (checked) next.add(index)
      else next.delete(index)
      return next
    })
  }

  /** Opens a fresh focused chat for the selected passage numbers. */
  function openAsk(indices: number[]): void {
    if (!indices.length || indices.length > 12) return
    audioRef.current?.pause()
    setAskIndices(indices)
    setMessages([])
    setQuestion("")
    setAskError(null)
    setAskOpen(true)
  }

  /** Sends the chosen passage IDs and in-dialog history to the Replies model. */
  async function askBlitz(): Promise<void> {
    const text = question.trim()
    if (!text || asking || !askIndices.length) return
    setAsking(true)
    setAskError(null)
    try {
      const response = await fetch(`${baseUrl}/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          segmentIndices: askIndices,
          question: text,
          history: messages.slice(-8).map((message) => ({
            role: message.role,
            text: message.text.slice(0, 3_000),
          })),
        }),
      })
      const payload = (await response.json()) as {
        answer?: string
        error?: string
      }
      if (!response.ok || !payload.answer)
        throw new Error(payload.error || "Blitz could not answer this passage.")
      setMessages((current) => [
        ...current,
        { role: "user", text },
        { role: "assistant", text: payload.answer! },
      ])
      setQuestion("")
    } catch (cause) {
      setAskError(
        cause instanceof Error
          ? cause.message
          : "Blitz could not answer this passage."
      )
    } finally {
      setAsking(false)
    }
  }

  if (loading)
    return (
      <main
        className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-8"
        aria-busy="true"
      >
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </main>
    )

  if (!recording || error)
    return (
      <main className="mx-auto max-w-4xl space-y-4 px-4 py-8 sm:px-8">
        <Button asChild variant="outline">
          <Link href={`/projects/${encodeURIComponent(projectId)}`}>
            Back to project
          </Link>
        </Button>
        <p role="alert" className="text-sm text-destructive">
          {error || "This recording is unavailable."}
        </p>
        <Button onClick={() => void loadRecording()}>Try again</Button>
      </main>
    )

  return (
    <main className="mx-auto max-w-6xl px-4 pt-6 pb-28 sm:px-8 sm:pt-10">
      <Button asChild variant="ghost" className="mb-6 -ml-3">
        <Link href={`/projects/${encodeURIComponent(projectId)}`}>
          ← Back to project
        </Link>
      </Button>
      <div className="mb-8">
        <p className="text-sm text-muted-foreground">
          {recording.item.kind === "podcast" ? "Project podcast" : "Audiobook"}
        </p>
        <h1 className="mt-1 font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          {recording.item.title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {formatTime(recording.transcript.durationSeconds)} of audio · Kokoro
          on this Mac
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)] lg:items-start">
        <section
          aria-label="Audio player"
          className="space-y-4 lg:sticky lg:top-8"
        >
          <audio
            ref={audioRef}
            className="w-full"
            controls
            preload="metadata"
            src={recording.item.audioUrl || `${baseUrl}/file`}
            onTimeUpdate={(event) =>
              setCurrentTime(event.currentTarget.currentTime)
            }
            onSeeked={(event) =>
              setCurrentTime(event.currentTarget.currentTime)
            }
          >
            Your browser does not support audio playback.
          </audio>
          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {formatTime(currentTime)} /{" "}
              {formatTime(recording.transcript.durationSeconds)}
            </span>
            <Button asChild variant="link" size="sm">
              <a
                href={`${recording.item.audioUrl || `${baseUrl}/file`}?download=1`}
                download
              >
                Download WAV
              </a>
            </Button>
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={activeIndex < 0}
            onClick={() => openAsk([activeIndex])}
          >
            Ask about this passage
          </Button>
          <p className="text-sm leading-6 text-muted-foreground">
            Follow the highlighted passage as it plays. Select passages in the
            transcript to ask about them together.
          </p>
        </section>

        <section aria-labelledby="transcript-heading" className="min-w-0">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2
                id="transcript-heading"
                className="font-heading text-xl font-medium"
              >
                Transcript
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {segments.length} timed passages
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              aria-pressed={followAlong}
              onClick={() => setFollowAlong((current) => !current)}
            >
              Follow along {followAlong ? "on" : "off"}
            </Button>
          </div>
          {selection.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 px-3 py-2">
              <span className="text-sm">{selection.length} selected</span>
              <Button
                size="sm"
                disabled={selection.length > 12}
                onClick={() => openAsk(selection)}
              >
                Ask Blitz
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIndices(new Set())}
              >
                Clear
              </Button>
              {selection.length > 12 ? (
                <span className="text-sm text-destructive">
                  Select up to 12 passages.
                </span>
              ) : null}
            </div>
          ) : null}
          <div
            ref={transcriptRef}
            className="relative max-h-[60svh] overflow-y-auto rounded-xl border border-border/70 lg:max-h-[72svh]"
          >
            {segments.map((segment, index) => {
              const active = index === activeIndex
              const selected = selectedIndices.has(index)
              return (
                <div
                  key={segment.index}
                  ref={(element) => {
                    passageRefs.current[index] = element
                  }}
                  className={cn(
                    "flex items-start gap-2 border-b border-border/50 px-3 py-3 last:border-b-0 sm:gap-3 sm:px-4",
                    active && "bg-brand/10",
                    selected && "ring-1 ring-brand/50 ring-inset"
                  )}
                >
                  <label className="flex min-h-10 min-w-10 shrink-0 items-center justify-center">
                    <Checkbox
                      checked={selected}
                      onCheckedChange={(value) =>
                        togglePassage(index, value === true)
                      }
                      aria-label={`Select passage at ${formatTime(segment.startSeconds)}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-md py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-current={active ? "true" : undefined}
                    onClick={() => seekTo(index)}
                  >
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span>{formatTime(segment.startSeconds)}</span>
                      {recording.item.kind === "podcast" ? (
                        <span>{speakerLabel(segment)}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "mt-1 block text-sm leading-6",
                        active && "font-medium"
                      )}
                    >
                      {segment.text}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      <Dialog open={askOpen} onOpenChange={setAskOpen}>
        <DialogContent className="flex max-h-[88svh] flex-col sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Ask about selected audio</DialogTitle>
            <DialogDescription>
              Blitz uses your Replies model and the selected transcript
              passages.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <blockquote className="max-h-36 overflow-y-auto border-l-2 border-brand pl-3 text-sm leading-6 text-muted-foreground">
              {askIndices
                .map((index) => segments[index]?.text)
                .filter(Boolean)
                .join(" ")}
            </blockquote>
            {messages.map((message, index) => (
              <div key={`${index}-${message.role}`} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {message.role === "user" ? "You" : "Blitz"}
                </p>
                {message.role === "assistant" ? (
                  <Markdown text={message.text} />
                ) : (
                  <p className="text-sm leading-6">{message.text}</p>
                )}
              </div>
            ))}
            {asking ? (
              <p role="status" className="text-sm text-muted-foreground">
                Blitz is answering…
              </p>
            ) : null}
          </div>
          <div className="space-y-2 pt-2">
            <label htmlFor="listening-question" className="text-sm font-medium">
              Your question
            </label>
            <Textarea
              id="listening-question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={2_000}
              disabled={asking}
              placeholder="What does this part mean?"
              className="min-h-20"
            />
            {askError ? (
              <p role="alert" className="text-sm text-destructive">
                {askError}
              </p>
            ) : null}
            <Button
              disabled={asking || question.trim().length < 2}
              onClick={() => void askBlitz()}
            >
              {asking ? "Asking…" : "Ask Blitz"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  )
}
