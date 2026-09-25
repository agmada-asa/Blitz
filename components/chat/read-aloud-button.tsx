"use client"

/** Speaks one reply or learning item with the user's first saved Kokoro voice. */
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useQuery } from "convex/react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { Tokens } from "marked"

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import { markdownText, parseMarkdown } from "@/lib/markdown"

/** Current local playback state for one readable item. */
type PlaybackState = "idle" | "loading" | "playing" | "error"

/** Keeps read aloud to one active reply or learning item across controls. */
let activeReadAloudStop: { id: symbol; stop: () => void } | undefined

/** Keeps each speech section short enough to start playback without a long wait. */
const SPEECH_SECTION_CHARS = 1_200

/** Represents a completed speech request or its recoverable failure. */
type SpeechRequestResult = { blob: Blob } | { error: unknown }

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

/** Splits narration into short sections at sentence or word boundaries. */
function splitSpeechText(text: string): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > SPEECH_SECTION_CHARS) {
    let boundary = 0
    for (const marker of [". ", "? ", "! ", "; ", ": ", "\n"]) {
      const index = remaining.lastIndexOf(
        marker,
        SPEECH_SECTION_CHARS - marker.length
      )
      boundary = Math.max(boundary, index < 0 ? 0 : index + marker.length)
    }
    if (!boundary) {
      const space = remaining.lastIndexOf(" ", SPEECH_SECTION_CHARS - 1)
      boundary = space > 0 ? space + 1 : SPEECH_SECTION_CHARS
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

/** Requests one WAV section and captures background errors until playback needs it. */
function requestSpeechAudio(
  text: string,
  voiceId: string,
  signal: AbortSignal
): Promise<SpeechRequestResult> {
  return (async () => {
    const response = await fetch("/api/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voiceId }),
      signal,
    })
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as {
        error?: string
      } | null
      throw new Error(result?.error || "Audio could not be generated.")
    }
    return await response.blob()
  })().then(
    (blob) => ({ blob }),
    (error: unknown) => ({ error })
  )
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

/** Adds a control to start or stop reading one item aloud. */
export function ReadAloudButton({ text }: { text: string }) {
  const savedSettings = useQuery(api.audioSettings.get)
  const voiceId = savedSettings?.voiceIds?.[0] ?? "af_heart"
  const [state, setState] = useState<PlaybackState>("idle")
  const [error, setError] = useState("")
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined)
  const objectUrlsRef = useRef(new Set<string>())
  const requestRef = useRef<AbortController | undefined>(undefined)
  const ownerRef = useRef<symbol | undefined>(undefined)

  /** Stops one audio element or all playback and releases its prepared URL. */
  const releaseAudio = useCallback(
    (audio?: HTMLAudioElement, url?: string) => {
      if (!audio || audioRef.current === audio) {
        audioRef.current?.pause()
        if (audioRef.current) audioRef.current.src = ""
        audioRef.current = undefined
      }
      if (url) {
        URL.revokeObjectURL(url)
        objectUrlsRef.current.delete(url)
      } else {
        for (const objectUrl of objectUrlsRef.current)
          URL.revokeObjectURL(objectUrl)
        objectUrlsRef.current.clear()
      }
    },
    []
  )

  /** Stops local audio, cancels speech requests, and releases prepared WAV URLs. */
  const stopPlayback = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = undefined
    releaseAudio()
    if (activeReadAloudStop?.id === ownerRef.current) {
      activeReadAloudStop = undefined
      ownerRef.current = undefined
    }
    setState("idle")
  }, [releaseAudio])

  useEffect(
    () => () => {
      requestRef.current?.abort()
      releaseAudio()
      if (activeReadAloudStop?.id === ownerRef.current)
        activeReadAloudStop = undefined
    },
    [releaseAudio]
  )

  /** Requests short Kokoro WAV sections and plays each as soon as it is ready. */
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
      let nextSpeech = requestSpeechAudio(
        chunks[0],
        voiceId,
        controller.signal
      )
      for (let index = 0; index < chunks.length; index += 1) {
        if (controller.signal.aborted) return
        setState("loading")
        const result = await nextSpeech
        if (controller.signal.aborted) return
        if ("error" in result) throw result.error
        const url = URL.createObjectURL(result.blob)
        objectUrlsRef.current.add(url)
        const audio = new Audio(url)
        audioRef.current = audio
        if (index + 1 < chunks.length)
          nextSpeech = requestSpeechAudio(
            chunks[index + 1],
            voiceId,
            controller.signal
          )
        setState("playing")
        await playAudioUntilEnded(audio, controller.signal)
        releaseAudio(audio, url)
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

  /** Toggles playback for this item without affecting other read aloud controls. */
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
