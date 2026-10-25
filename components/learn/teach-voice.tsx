"use client"

/**
 * Voice for Teach: the tutor's new replies read aloud with local Kokoro, and
 * questions spoken into the question box with on-device speech to text.
 * Together they let a learner go through a unit hands-free.
 *
 * Reading uses the same Kokoro playback as each section's Read aloud button,
 * and claims it, so only one thing speaks at once. Dictation records only
 * while the mic button is on, fills the question box, and leaves the learner
 * to send or edit; starting it stops the tutor mid-sentence.
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
import { LoadingIcon } from "@/components/ui/icon"
import { claimReadAloud } from "@/components/chat/read-aloud-button"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"
import { playSpeechSections } from "@/lib/client/speech-playback"
import {
  startSpeechRecording,
  transcribeRecording,
  warmSpeechToText,
  type SpeechRecording,
} from "@/lib/client/speech-recording"
import { splitSpeechText } from "@/lib/speech-text"
import { spokenMarkdownText } from "@/lib/spoken-markdown"
import {
  parseTeachSectionMarker,
  stripTeachMarkers,
  type TeachOutline,
} from "@/lib/teach"

/** Where the learner's choice to hear replies is kept between visits. */
const READ_REPLIES_KEY = "blitz.teach.readRepliesAloud"

/** Stops the reply being read, if any; set by the active reader. */
let stopActiveReply: (() => void) | undefined

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
 * Reads each new tutor reply aloud once it is complete, while `enabled`.
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

  /** Reads one reply, replacing anything else being read aloud. */
  const read = useCallback(
    async (text: string) => {
      const chunks = splitSpeechText(spokenMarkdownText(text))
      if (!chunks.length) return
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      const stopThis = () => {
        controller.abort()
        if (controllerRef.current === controller) {
          controllerRef.current = undefined
          setState("idle")
        }
      }
      const release = claimReadAloud(stopThis)
      stopActiveReply = stopThis
      setError("")
      setState("loading")
      try {
        await playSpeechSections(chunks, voiceId, controller.signal, (next) => {
          if (!controller.signal.aborted) setState(next)
        })
        if (!controller.signal.aborted) setState("idle")
      } catch (caught) {
        if (controller.signal.aborted) return
        setError(
          caught instanceof Error ? caught.message : "The reply could not be read aloud."
        )
        setState("error")
      } finally {
        release()
        if (stopActiveReply === stopThis) stopActiveReply = undefined
        if (controllerRef.current === controller) controllerRef.current = undefined
      }
    },
    [voiceId]
  )

  const last = messages.findLast((message) => message.role === "assistant")
  useEffect(() => {
    if (!last) return
    if (last.status === "running") {
      writtenHere.current.add(last.id)
      return
    }
    // Wait for the saved voice, so the first reply uses the learner's choice.
    if (
      !enabled ||
      savedSettings === undefined ||
      last.status !== "completed" ||
      !writtenHere.current.has(last.id) ||
      spoken.current.has(last.id)
    )
      return
    spoken.current.add(last.id)
    void read(spokenReplyText(last.content, outline))
  }, [enabled, last, outline, read, savedSettings])

  useEffect(() => () => controllerRef.current?.abort(), [])

  return { state, error, stop }
}

/**
 * The header control that turns reading replies aloud on or off, and stops a
 * reply being read.
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
    <div className="flex shrink-0 items-center gap-1">
      {reading ? (
        <Button
          type="button"
          variant="outline"
          onClick={reader.stop}
          className="min-h-10 rounded-full px-3"
        >
          {reader.state === "loading" ? (
            <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <HugeiconsIcon icon={StopIcon} size={16} aria-hidden="true" />
          )}
          Stop reading
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        aria-pressed={enabled}
        onClick={() => {
          if (enabled) reader.stop()
          onChange(!enabled)
        }}
        title={reader.state === "error" ? reader.error : "Read replies aloud"}
        className="min-h-10 gap-2 rounded-full px-3"
      >
        <span
          aria-hidden="true"
          className={cn(
            "relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors motion-reduce:transition-none",
            enabled ? "bg-brand" : "bg-muted-foreground/30"
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-3 rounded-full bg-background transition-transform motion-reduce:transition-none",
              enabled ? "translate-x-3.5" : "translate-x-0.5"
            )}
          />
        </span>
        {/* Narrow headers keep the switch alone so the unit title stays readable. */}
        <span className="sr-only sm:not-sr-only">Read replies aloud</span>
      </Button>
    </div>
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
 * Records a spoken question and hands its text over.
 *
 * `toggle` starts listening (stopping any reply being read) and, pressed
 * again, stops and transcribes. The model is warmed as recording starts.
 *
 * @param onText - Receives the transcript of each question.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>("idle")
  const [error, setError] = useState("")
  const recordingRef = useRef<SpeechRecording | undefined>(undefined)
  const requestRef = useRef<AbortController | undefined>(undefined)

  useEffect(
    () => () => {
      recordingRef.current?.cancel()
      requestRef.current?.abort()
    },
    []
  )

  const toggle = useCallback(() => {
    if (state === "starting" || state === "transcribing") return
    if (state === "listening") {
      const recording = recordingRef.current
      recordingRef.current = undefined
      if (!recording) return
      setState("transcribing")
      const controller = new AbortController()
      requestRef.current = controller
      void (async () => {
        try {
          const text = (await transcribeRecording(await recording.stop(), controller.signal)).trim()
          if (text) onText(text)
          else setError("Nothing was heard. Try again a little closer to the mic.")
        } catch (caught) {
          if (!controller.signal.aborted) setError(dictationError(caught))
        } finally {
          if (requestRef.current === controller) requestRef.current = undefined
          setState("idle")
        }
      })()
      return
    }
    setError("")
    setState("starting")
    stopActiveReply?.()
    warmSpeechToText()
    void startSpeechRecording().then(
      (recording) => {
        recordingRef.current = recording
        setState("listening")
      },
      (caught: unknown) => {
        setError(dictationError(caught))
        setState("idle")
      }
    )
  }, [state, onText])

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
      aria-label={listening ? "Stop and transcribe" : "Speak your question"}
      disabled={(disabled && !listening) || busy}
      onClick={dictation.toggle}
      className={cn(
        "size-11 shrink-0 rounded-full",
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
      ? "Listening… tap the mic to stop, then send or edit"
      : dictation.state === "transcribing"
        ? "Turning your question into text…"
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
