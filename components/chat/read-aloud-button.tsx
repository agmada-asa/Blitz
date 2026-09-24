"use client"

/** Speaks one completed Blitz reply with the user's first saved Kokoro voice. */
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useQuery } from "convex/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Tokens } from "marked"

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import { markdownText, parseMarkdown } from "@/lib/markdown"

/** Current local playback state for a single assistant reply. */
type PlaybackState = "idle" | "loading" | "playing" | "error"

/** Keeps chat read aloud to one active reply at a time across message controls. */
let activeReadAloudStop: { id: symbol; stop: () => void } | undefined

/** Maximum text size sent to the speech endpoint in one request. */
const MAX_SPEECH_CHARS = 12_000

/** Removes Markdown structure while keeping the visible prose and link labels. */
function plainReplyText(markdown: string): string {
  /** Collects human-readable text from nested Marked tokens, skipping code and media. */
  function collect(tokens: ReturnType<typeof parseMarkdown>): string[] {
    return tokens.flatMap((token) => {
      if (
        token.type === "code" ||
        token.type === "image" ||
        token.type === "space"
      )
        return []
      if ("tokens" in token && token.tokens)
        return collect(token.tokens as ReturnType<typeof parseMarkdown>)
      if (token.type === "list")
        return token.items.flatMap((item: Tokens.ListItem) =>
          collect(item.tokens as ReturnType<typeof parseMarkdown>)
        )
      if ("text" in token && typeof token.text === "string")
        return [markdownText(token.text)]
      return []
    })
  }

  return collect(parseMarkdown(markdown)).join(" ").replace(/\s+/g, " ").trim()
}

/** Splits long narration at sentence or word boundaries within the route limit. */
function splitSpeechText(text: string): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > MAX_SPEECH_CHARS) {
    let boundary = 0
    for (const marker of [". ", "? ", "! ", "; ", ": ", "\n"]) {
      const index = remaining.lastIndexOf(
        marker,
        MAX_SPEECH_CHARS - marker.length
      )
      boundary = Math.max(boundary, index < 0 ? 0 : index + marker.length)
    }
    if (!boundary) {
      const space = remaining.lastIndexOf(" ", MAX_SPEECH_CHARS - 1)
      boundary = space > 0 ? space + 1 : MAX_SPEECH_CHARS
    }
    if (
      boundary < remaining.length &&
      remaining.charCodeAt(boundary - 1) >= 0xd800 &&
      remaining.charCodeAt(boundary - 1) <= 0xdbff &&
      remaining.charCodeAt(boundary) >= 0xdc00 &&
      remaining.charCodeAt(boundary) <= 0xdfff
    )
      boundary -= 1
    const chunk = remaining.slice(0, boundary).trim()
    if (chunk) chunks.push(chunk)
    remaining = remaining.slice(boundary).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

/** Plays one audio element until it ends or the owning read aloud request stops. */
function playAudioUntilEnded(
  audio: HTMLAudioElement,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    /** Removes playback listeners after success, failure, or cancellation. */
    function cleanup() {
      audio.removeEventListener("ended", onEnded)
      audio.removeEventListener("error", onError)
      signal.removeEventListener("abort", onAbort)
    }
    /** Completes the chunk after its audio reaches the end. */
    function onEnded() {
      cleanup()
      resolve()
    }
    /** Reports browser playback errors so the control can offer a retry. */
    function onError() {
      cleanup()
      reject(new Error("Audio could not be played."))
    }
    /** Ends the current chunk promptly when the user stops or switches replies. */
    function onAbort() {
      cleanup()
      reject(new DOMException("Audio playback stopped.", "AbortError"))
    }

    audio.addEventListener("ended", onEnded, { once: true })
    audio.addEventListener("error", onError, { once: true })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void audio.play().catch((error: unknown) => {
      cleanup()
      reject(error)
    })
  })
}

/** Adds a user initiated play or stop control to one assistant reply. */
export function ReadAloudButton({ text }: { text: string }) {
  const savedSettings = useQuery(api.audioSettings.get)
  const voiceId = savedSettings?.voiceIds?.[0] ?? "af_heart"
  const [state, setState] = useState<PlaybackState>("idle")
  const [error, setError] = useState("")
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined)
  const objectUrlRef = useRef<string | undefined>(undefined)
  const requestRef = useRef<AbortController | undefined>(undefined)
  const ownerRef = useRef<symbol | undefined>(undefined)

  /** Stops local audio, cancels generation, and releases the generated WAV URL. */
  const stopPlayback = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = undefined
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ""
      audioRef.current = undefined
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = undefined
    if (activeReadAloudStop?.id === ownerRef.current) {
      activeReadAloudStop = undefined
      ownerRef.current = undefined
    }
    setState("idle")
  }, [])

  /** Releases the current audio element and its temporary generated WAV URL. */
  function releaseAudio() {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ""
      audioRef.current = undefined
    }
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    objectUrlRef.current = undefined
  }

  useEffect(
    () => () => {
      requestRef.current?.abort()
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ""
      }
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
      if (activeReadAloudStop?.id === ownerRef.current)
        activeReadAloudStop = undefined
    },
    [stopPlayback]
  )

  /** Requests a local Kokoro WAV and starts playback, reporting recoverable failures. */
  async function startPlayback() {
    const chunks = splitSpeechText(plainReplyText(text))
    if (!chunks.length) return
    setError("")
    setState("loading")
    activeReadAloudStop?.stop()
    const controller = new AbortController()
    const ownerId = Symbol()
    requestRef.current = controller
    ownerRef.current = ownerId
    activeReadAloudStop = { id: ownerId, stop: stopPlayback }
    try {
      for (const chunk of chunks) {
        if (controller.signal.aborted) return
        setState("loading")
        const response = await fetch("/api/audio/speech", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: chunk, voiceId }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const result = (await response.json().catch(() => null)) as {
            error?: string
          } | null
          throw new Error(result?.error || "Audio could not be generated.")
        }
        const url = URL.createObjectURL(await response.blob())
        objectUrlRef.current = url
        const audio = new Audio(url)
        audioRef.current = audio
        setState("playing")
        await playAudioUntilEnded(audio, controller.signal)
        if (audioRef.current === audio) audioRef.current = undefined
        if (objectUrlRef.current === url) {
          URL.revokeObjectURL(url)
          objectUrlRef.current = undefined
        }
      }
      setState("idle")
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(
        caught instanceof Error ? caught.message : "Audio could not be played."
      )
      setState("error")
      releaseAudio()
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined
      if (activeReadAloudStop?.id === ownerId) activeReadAloudStop = undefined
    }
  }

  /** Toggles playback for this reply without affecting other chat messages. */
  function togglePlayback() {
    if (state === "loading" || state === "playing") stopPlayback()
    else void startPlayback()
  }

  return (
    <span className="inline-flex flex-col items-start">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
        aria-label={
          state === "playing" || state === "loading"
            ? "Stop read aloud"
            : "Read aloud"
        }
        onClick={togglePlayback}
      >
        {state === "loading" ? (
          <LoadingIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
        ) : (
          <HugeiconsIcon
            icon={state === "playing" ? PauseIcon : PlayIcon}
            size={14}
            aria-hidden="true"
          />
        )}
        {state === "loading"
          ? "Preparing audio…"
          : state === "playing"
            ? "Stop reading"
            : "Read aloud"}
      </Button>
      {state === "error" ? (
        <span role="status" className="px-2 text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  )
}
