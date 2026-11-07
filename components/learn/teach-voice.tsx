"use client"

/**
 * Voice for Teach: the tutor's new replies read aloud with local Kokoro, and
 * questions spoken into the question box with on-device speech to text.
 * Together they let a learner go through a unit hands-free.
 *
 * Reading uses the same Kokoro playback as each section's Read aloud button,
 * and claims it, so only one thing speaks at once. Dictation records only
 * while the mic button is on, fills the question box, and leaves the learner
 * to send or edit. Continuous listening and interruption live in voice mode.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useQuery } from "convex/react"
import { Mic01Icon, StopIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenuItem,
  DropdownMenuSwitchItem,
} from "@/components/ui/dropdown-menu"
import { LoadingIcon } from "@/components/ui/icon"
import { claimReadAloud } from "@/components/chat/read-aloud-button"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"
import { StreamingSpeech } from "@/lib/client/streaming-speech"
import { VoiceConnection } from "@/lib/client/voice-connection"
import {
  parseTeachSectionMarker,
  stripTeachMarkers,
  type TeachOutline,
} from "@/lib/teach"

/** Where the learner's choice to hear replies is kept between visits. */
const READ_REPLIES_KEY = "blitz.teach.readRepliesAloud"

/** One tutor or learner message, as far as reading it aloud needs. */
type VoiceMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  status: "running" | "completed" | "failed"
}

/**
 * Returns the words to read for one tutor reply: its section title, when it
 * opens a section, then its lesson text without Teach's markers.
 */
export function spokenReplyText(
  content: string,
  outline: TeachOutline | null
): string {
  const marker = parseTeachSectionMarker(content)
  const title =
    marker?.kind === "section"
      ? outline?.sections.find((section) => section.id === marker.id)?.title
      : undefined
  const body = stripTeachMarkers(content)
  return title ? `${title}\n\n${body}` : body
}

/** Listeners told when the saved choice changes in this tab. */
const settingListeners = new Set<() => void>()

/** Subscribes to the saved choice, in this tab and in others. */
function subscribeReadReplies(listener: () => void): () => void {
  settingListeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    settingListeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

/** Reads the saved choice; storage can be unavailable, which means off. */
function readRepliesSnapshot(): boolean {
  try {
    return window.localStorage.getItem(READ_REPLIES_KEY) === "on"
  } catch {
    return false
  }
}

/**
 * Keeps the learner's "Read replies aloud" choice, saved in this browser. It
 * is off during the server render.
 *
 * @returns The choice and a setter that saves it.
 */
export function useReadRepliesSetting(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeReadReplies,
    readRepliesSnapshot,
    () => false
  )
  const update = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(READ_REPLIES_KEY, next ? "on" : "off")
    } catch {
      // Without storage the choice cannot be kept; it stays as it was.
    }
    for (const listener of settingListeners) listener()
  }, [])
  return [enabled, update]
}

/** What the reply reader is doing. */
export type ReplyReaderState = "idle" | "loading" | "playing" | "error"

/**
 * Reads complete pieces of each growing tutor reply while `enabled`.
 *
 * Only replies written while this screen is open are read, so returning to a
 * unit does not read its history. The toggle stops a reply when reading is
 * turned off.
 *
 * @param enabled - The learner's "Read replies aloud" choice.
 * @param messages - The Teach chat's messages, oldest first.
 * @param outline - The unit outline, for section titles.
 * @returns The reader's state, its last error, and a stop control.
 */
export function useReplyReader(
  enabled: boolean,
  messages: readonly VoiceMessage[],
  outline: TeachOutline | null
): { state: ReplyReaderState; error: string; stop: () => void } {
  const savedSettings = useQuery(api.audioSettings.get)
  const voiceId = savedSettings?.voiceIds?.[0] ?? "af_heart"
  const [state, setState] = useState<ReplyReaderState>("idle")
  const [error, setError] = useState("")
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const writtenHere = useRef(new Set<string>())
  const spoken = useRef(new Set<string>())

  const stop = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = undefined
    setState("idle")
  }, [])

  const stream = useRef<StreamingSpeech | undefined>(undefined)
  const streamId = useRef("")
  const last = messages.findLast((message) => message.role === "assistant")
  useEffect(() => {
    if (!enabled) { stream.current?.stop(); return }
    if (!last || savedSettings === undefined) return
    if (last.status === "running") writtenHere.current.add(last.id)
    if (!writtenHere.current.has(last.id) || spoken.current.has(last.id)) return
    if (streamId.current !== last.id) {
      stream.current?.stop()
      const controller = new AbortController()
      controllerRef.current = controller
      const current = new StreamingSpeech(voiceId, setState, caught => {
        setError(caught instanceof Error ? caught.message : "The reply could not be read aloud.")
        setState("error")
      })
      stream.current = current
      streamId.current = last.id
      const release = claimReadAloud(() => current.stop())
      controller.signal.addEventListener("abort", () => { current.stop(); release() }, { once: true })
    }
    stream.current?.update(spokenReplyText(last.content, outline), last.status !== "running")
    if (last.status !== "running") {
      spoken.current.add(last.id)
      const current = stream.current
      void current?.done().then(() => { if (!current.failed && stream.current === current) setState("idle") })
    }
  }, [enabled, last, outline, savedSettings, voiceId])

  useEffect(() => () => controllerRef.current?.abort(), [])

  return { state, error, stop }
}

/**
 * Unit menu settings for reading new replies aloud and stopping playback.
 */
export function ReadRepliesToggle({
  enabled,
  onChange,
  reader,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  reader: { state: ReplyReaderState; error: string; stop: () => void }
}) {
  const reading = reader.state === "loading" || reader.state === "playing"
  return (
    <>
      <DropdownMenuSwitchItem
        checked={enabled}
        onCheckedChange={(checked) => {
          if (!checked) reader.stop()
          onChange(checked)
        }}
        title={reader.state === "error" ? reader.error : undefined}
        className="min-h-11"
      >
        Read replies aloud
      </DropdownMenuSwitchItem>
      {reading ? (
        <DropdownMenuItem
          onSelect={reader.stop}
          className="min-h-11"
        >
          Stop reading
          {reader.state === "loading" ? (
            <LoadingIcon className="ml-auto size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <HugeiconsIcon icon={StopIcon} size={16} aria-hidden="true" className="ml-auto" />
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

/** What dictation is doing. */
export type DictationState = "idle" | "starting" | "listening" | "transcribing"

/** One dictation session's state and controls, from {@link useDictation}. */
export interface Dictation {
  state: DictationState
  error: string
  toggle: () => void
}

/** Turns a recording failure into copy the learner can act on. */
function dictationError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError")
      return "Blitz can't use the microphone. Allow it in System Settings › Privacy & Security › Microphone, then try again."
    if (error.name === "NotFoundError") return "No microphone was found."
  }
  return error instanceof Error && error.message
    ? error.message
    : "Your question could not be recorded. Try again."
}

/**
 * Records a spoken question and hands its text over as it is spoken.
 *
 * `toggle` starts listening and, pressed again, stops and finishes the transcript. The model is
 * warmed as recording starts. Words arrive about once a second while the learner talks, each time
 * as the whole dictation so far, so the caller can replace rather than append.
 *
 * @param onText - Receives the dictation so far; `final` is true once, for the finished transcript.
 */
export function useDictation(onText: (text: string, final: boolean) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle")
  const [error, setError] = useState("")
  const connection = useRef<VoiceConnection | undefined>(undefined)
  const mounted = useRef(true)
  const callback = useRef(onText)
  useEffect(() => { callback.current = onText })
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; connection.current?.close() }
  }, [])

  const toggle = useCallback(() => {
    if (state === "starting") { connection.current?.close(); return }
    if (state === "transcribing") return
    if (state === "listening") {
      setState("transcribing")
      connection.current?.finish()
      return
    }
    setError("")
    setState("starting")
    const current = new VoiceConnection(event => {
      if (!mounted.current || connection.current !== current) return
      if (event.type === "caption" && event.text?.trim()) callback.current(event.text.trim(), false)
      if (event.type === "user") {
        if (event.text?.trim()) callback.current(event.text.trim(), true)
        else setError("Nothing was heard. Try again closer to the mic.")
        current.close()
      }
      if (event.type === "error") { setError(event.message || "Dictation failed."); current.close() }
      if (event.type === "closed") { connection.current = undefined; setState("idle") }
    })
    connection.current = current
    void current.start("dictate").then(() => {
      if (mounted.current && connection.current === current) setState("listening")
    }).catch(caught => {
      if (!mounted.current || connection.current !== current) return
      setError(dictationError(caught)); current.close()
    })
  }, [state])

  return { state, error, toggle }
}

/** The mic button beside the question box. */
export function DictationButton({
  dictation,
  disabled,
}: {
  dictation: Dictation
  disabled: boolean
}) {
  const listening = dictation.state === "listening"
  const busy = dictation.state === "starting" || dictation.state === "transcribing"
  return (
    <Button
      type="button"
      size="icon"
      variant={listening ? "default" : "outline"}
      aria-pressed={listening}
      aria-label={dictation.state === "starting" ? "Cancel microphone" : listening ? "Stop and transcribe" : "Speak your question"}
      disabled={(disabled && !listening && dictation.state !== "starting") || dictation.state === "transcribing"}
      onClick={dictation.toggle}
      className={cn(
        "min-h-11 min-w-11 shrink-0 rounded-full",
        listening && "bg-destructive text-white hover:bg-destructive/90"
      )}
    >
      {busy ? (
        <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
      ) : (
        <HugeiconsIcon icon={listening ? StopIcon : Mic01Icon} size={18} aria-hidden="true" />
      )}
    </Button>
  )
}

/** The line under the question box while dictating, or its last error. */
export function DictationStatus({ dictation }: { dictation: Dictation }) {
  const text =
    dictation.state === "listening"
      ? "Listening… tap stop when you're done, then send or edit"
      : dictation.state === "transcribing"
        ? "Finishing the last words…"
        : dictation.state === "starting"
          ? "Opening the microphone…"
          : ""
  if (dictation.error)
    return (
      <p role="alert" className="mt-2 text-sm text-destructive">
        {dictation.error}
      </p>
    )
  return text ? (
    <p role="status" className="mt-2 text-sm text-muted-foreground">
      {text}
    </p>
  ) : null
}
