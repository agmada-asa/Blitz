"use client"

/** Speaks one reply or learning item with the user's first saved Kokoro voice. */
import { PauseIcon, PlayIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useQuery } from "convex/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { Tokens } from "marked"

import { Button } from "@/components/ui/button"
import { LoadingIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import { markdownText, parseMarkdown } from "@/lib/markdown"
import { splitSpeechText } from "@/lib/speech-text"
import {
  playSpeechSections,
  prepareSpeechOpening,
} from "@/lib/client/speech-playback"

/** Current local playback state for one readable item. */
type PlaybackState = "idle" | "loading" | "playing" | "error"

/** Keeps read aloud to one active reply or learning item across controls. */
let activeReadAloudStop: { id: symbol; stop: () => void } | undefined

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

/** Reads one item; prepare opts only active content into quiet preparation while visible. */
export function ReadAloudButton({
  text,
  prepare = false,
}: {
  text: string
  prepare?: boolean
}) {
  const savedSettings = useQuery(api.audioSettings.get)
  const voiceId = savedSettings?.voiceIds?.[0] ?? "af_heart"
  const chunks = useMemo(() => splitSpeechText(plainReplyText(text)), [text])
  const [state, setState] = useState<PlaybackState>("idle")
  const [error, setError] = useState("")
  const buttonRef = useRef<HTMLButtonElement>(null)
  const preparationKeyRef = useRef<string | undefined>(undefined)
  const releasePreparationRef = useRef<(() => void) | undefined>(undefined)
  const requestRef = useRef<AbortController | undefined>(undefined)
  const ownerRef = useRef<symbol | undefined>(undefined)

  /** Stops playing and scheduled sections and drops this control's pending speech requests. */
  const stopPlayback = useCallback(() => {
    requestRef.current?.abort()
    requestRef.current = undefined
    if (activeReadAloudStop?.id === ownerRef.current) {
      activeReadAloudStop = undefined
      ownerRef.current = undefined
    }
    setState("idle")
  }, [])

  /** Prepares only the opening, using the same text and voice as foreground playback. */
  const prepareOpening = useCallback(() => {
    if (savedSettings === undefined || !chunks[0]) return
    const key = JSON.stringify([voiceId, chunks[0]])
    if (preparationKeyRef.current === key) return
    releasePreparationRef.current?.()
    preparationKeyRef.current = key
    const release = prepareSpeechOpening(chunks[0], voiceId)
    releasePreparationRef.current = () => {
      release()
      preparationKeyRef.current = undefined
    }
  }, [chunks, savedSettings, voiceId])

  useEffect(() => {
    if (!prepare || savedSettings === undefined) return
    const button = buttonRef.current
    if (!button) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let visible = false
    /** Prepares visible content after a brief delay and cancels when its tab or control disappears. */
    function prepareWhenVisible() {
      if (timer) clearTimeout(timer)
      if (visible && document.visibilityState === "visible") {
        timer = setTimeout(prepareOpening, 250)
      } else releasePreparationRef.current?.()
    }
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      prepareWhenVisible()
    })
    observer.observe(button)
    document.addEventListener("visibilitychange", prepareWhenVisible)
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", prepareWhenVisible)
      if (timer) clearTimeout(timer)
      releasePreparationRef.current?.()
    }
  }, [prepare, prepareOpening, savedSettings])

  useEffect(
    () => () => {
      stopPlayback()
      releasePreparationRef.current?.()
    },
    [text, voiceId, stopPlayback]
  )

  /** Requests short Kokoro WAV sections and plays each as soon as it is ready. */
  async function startPlayback() {
    if (!chunks.length) return
    activeReadAloudStop?.stop()
    setError("")
    setState("loading")
    const controller = new AbortController()
    const ownerId = Symbol()
    requestRef.current = controller
    ownerRef.current = ownerId
    activeReadAloudStop = { id: ownerId, stop: stopPlayback }
    try {
      await playSpeechSections(
        chunks,
        voiceId,
        controller.signal,
        (nextState) => {
          if (!controller.signal.aborted) setState(nextState)
        }
      )
      setState("idle")
    } catch (caught) {
      if (controller.signal.aborted) return
      setError(
        caught instanceof Error ? caught.message : "Audio could not be played."
      )
      setState("error")
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined
      if (activeReadAloudStop?.id === ownerId) activeReadAloudStop = undefined
    }
  }

  /** Stops this item or starts it after releasing any other active read aloud control. */
  function togglePlayback() {
    if (requestRef.current) stopPlayback()
    else void startPlayback()
  }

  return (
    <span className="inline-flex flex-col items-start">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        className="h-10 gap-1.5 px-2.5 text-xs font-normal sm:h-7 sm:px-2"
        aria-label={
          state === "playing" || state === "loading"
            ? "Stop read aloud"
            : "Read aloud"
        }
        onPointerEnter={prepareOpening}
        onFocus={prepareOpening}
        onPointerLeave={() => releasePreparationRef.current?.()}
        onBlur={() => releasePreparationRef.current?.()}
        disabled={!chunks.length}
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
