"use client"

/**
 * Hands-free voice for chat and Teach. {@link useVoiceSession} owns the microphone socket, the
 * growing-reply reader and turn hand-off; {@link VoiceBar} takes the composer's place while a
 * session is on, and {@link TalkButton} starts one. The owning screen persists turns as usual.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useQuery } from "convex/react"
import { HugeiconsIcon } from "@hugeicons/react"
import { AudioWave01Icon, Cancel01Icon, KeyboardIcon, Mic01Icon, MicOff01Icon, NextIcon } from "@hugeicons/core-free-icons"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { claimReadAloud } from "@/components/chat/read-aloud-button"
import { VoiceOrb, type OrbState } from "@/components/voice/voice-orb"
import { VoiceConnection } from "@/lib/client/voice-connection"
import { StreamingSpeech } from "@/lib/client/streaming-speech"
import { speechOutputLevel, unlockSpeech } from "@/lib/client/speech-playback"
import { cn } from "@/lib/utils"

/** What a voice session is doing. */
export type VoicePhase = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking"

/** The reply being read: its id, the text so far, and whether it has finished. */
export type VoiceReply = { id: string; text: string; complete: boolean } | null

/** A running voice session's state and controls. */
export type VoiceSession = {
  phase: VoicePhase
  muted: boolean
  error: string
  /** The learner's words: live while they talk, final while Blitz thinks. */
  heard: string
  /** The sentence being spoken now. */
  speaking: string
  /** What the learner cut off: the words heard and those dropped. */
  cut: { heard: string; unheard: string } | null
  start: () => void
  stop: () => void
  mute: (value: boolean) => void
  /** Sends words as a spoken turn, interrupting a reply in progress. */
  say: (text: string) => void
  dismissError: () => void
  levels: () => { mic: number; out: number }
}

/** Turns a start failure into copy the learner can act on. */
function startError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError")
    return "Blitz can't use the microphone. Allow the mic for this site in your browser's settings, then try again."
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone was found."
  return error instanceof Error && error.message ? error.message : "Voice couldn't start. Try again."
}

/**
 * Runs one hands-free voice session: listens continuously, sends finished turns, reads the growing
 * reply sentence by sentence, and stops it when the learner talks over it.
 */
export function useVoiceSession({ onTurn, onInterrupt, reply, busy, readOnStart = false }: {
  onTurn: (text: string) => Promise<unknown>
  onInterrupt: () => void
  reply: VoiceReply
  busy: boolean
  /** Read the latest reply as soon as voice starts, instead of only new ones. */
  readOnStart?: boolean
}): VoiceSession {
  const settings = useQuery(api.audioSettings.get)
  const [phase, setPhase] = useState<VoicePhase>("off")
  const [error, setError] = useState("")
  const [muted, setMuted] = useState(false)
  const [heard, setHeard] = useState("")
  const [speaking, setSpeaking] = useState("")
  const [cut, setCut] = useState<VoiceSession["cut"]>(null)
  const connection = useRef<VoiceConnection | null>(null)
  const reader = useRef<StreamingSpeech | null>(null)
  const readingId = useRef("")
  const loggedReply = useRef("")
  const pending = useRef("")
  const callbacks = useRef({ onTurn, onInterrupt, busy, muted })
  const release = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  const session = useRef(0)
  const cutOff = useRef<string | null>(null)
  const turnAt = useRef(0)
  const wakeLock = useRef<WakeLockSentinel | null>(null)
  // Event callbacks see the current turn state without reopening the microphone.
  useEffect(() => { callbacks.current = { onTurn, onInterrupt, busy, muted } })

  /** Releases capture, speech, wake lock and queued unsent words. */
  const stop = useCallback(() => {
    session.current++
    connection.current?.close(); connection.current = null
    reader.current?.stop(); reader.current = null
    release.current?.(); release.current = null
    void wakeLock.current?.release(); wakeLock.current = null
    pending.current = ""; readingId.current = ""; cutOff.current = null
    setPhase("off"); setMuted(false); setHeard(""); setSpeaking(""); setCut(null)
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; connection.current?.close(); reader.current?.stop(); release.current?.(); void wakeLock.current?.release() }
  }, [])

  /** Sends a turn now, or queues it and interrupts the reply that is still being written. */
  const sendTurn = useCallback((text: string) => {
    turnAt.current = performance.now()
    reader.current?.stop()
    if (callbacks.current.busy) { pending.current = text; callbacks.current.onInterrupt() }
    else void callbacks.current.onTurn(text).catch(caught => setError(caught instanceof Error ? caught.message : "Your turn failed. Try again."))
  }, [])

  // Reads the reply as it grows; a new reply id starts a new reader.
  useEffect(() => {
    if (phase === "off" || phase === "starting" || !reply) return
    if (readingId.current !== reply.id) {
      reader.current?.stop()
      const current = new StreamingSpeech(settings?.voiceIds?.[0] ?? "af_heart", next => {
        if (reader.current !== current) return
        setPhase(next === "playing" ? "speaking" : "thinking")
      }, caught => setError(caught instanceof Error ? caught.message : "Speech failed. Try again."), synthesisMs => {
        connection.current?.send({ type: "timing", heardMs: performance.now() - turnAt.current, synthesisMs })
      })
      current.onSpeaking = text => { if (reader.current === current) { setSpeaking(text); setCut(null) } }
      reader.current = current
      readingId.current = reply.id
    }
    reader.current?.update(reply.text, reply.complete)
    if (reply.complete) {
      const current = reader.current
      void current?.done().then(() => {
        if (!current.failed && reader.current === current && connection.current) { setPhase("listening"); setSpeaking("") }
      })
      if (loggedReply.current !== reply.id && current) {
        loggedReply.current = reply.id
        connection.current?.send({ type: "reply", text: reply.text.slice(0, 6000) })
      }
    }
  }, [reply, settings, phase])

  // A turn queued while the last reply was being stopped goes out once it has stopped.
  useEffect(() => {
    if (!busy && pending.current && connection.current) {
      const text = pending.current; pending.current = ""
      void onTurn(text).catch(caught => setError(caught instanceof Error ? caught.message : "Your turn failed. Try again."))
    }
  }, [busy, onTurn, phase])

  /** Opens audio on the learner's gesture, then starts one microphone session. */
  const start = useCallback(() => {
    setError(""); setPhase("starting"); setHeard(""); setSpeaking(""); setCut(null)
    unlockSpeech()
    readingId.current = readOnStart ? "" : reply?.id ?? ""
    const generation = ++session.current
    release.current = claimReadAloud(() => reader.current?.stop())
    const socket = new VoiceConnection(event => {
      if (!mounted.current || generation !== session.current) return
      if (event.type === "error") { setError(event.message || "Voice failed."); stop() }
      if (event.type === "closed") { if (connection.current === socket) stop() }
      if (callbacks.current.muted) return
      if (event.type === "state" && event.state) {
        // While a reply plays, only the learner starting to talk changes what the bar shows.
        if (event.state === "hearing") { setPhase("hearing"); setHeard("") }
        else if (event.state === "thinking") setPhase("thinking")
        else if (!reader.current?.active) setPhase("listening")
      }
      if (event.type === "caption" && typeof event.text === "string") setHeard(event.text)
      if (event.type === "interrupt") {
        if (!callbacks.current.busy && !reader.current?.active) return
        const split = reader.current?.split() ?? null
        cutOff.current = reader.current?.heard() ?? ""
        if (split?.unheard) setCut(split)
        reader.current?.stop()
        if (callbacks.current.busy) callbacks.current.onInterrupt()
      }
      if (event.type === "user" && event.text) {
        const words = event.text.trim()
        setHeard(words); setPhase("thinking")
        const text = cutOff.current === null || readOnStart ? words : words +
          (cutOff.current ? '\n\n[Your previous reply was interrupted. The learner heard only: "' + cutOff.current.slice(-2000) + '".]' : "\n\n[The learner was still adding to the previous question; none of the reply was heard.]")
        cutOff.current = null
        sendTurn(text)
      }
    })
    connection.current = socket
    void (async () => {
      try {
        await socket.start("voice", reply?.text ?? "")
        if (connection.current !== socket) return
        setPhase("listening")
        if ("wakeLock" in navigator) {
          const lock = await navigator.wakeLock.request("screen").catch(() => null)
          if (connection.current === socket) wakeLock.current = lock
          else void lock?.release()
        }
      } catch (caught) {
        if (generation === session.current) { stop(); setError(startError(caught)) }
      }
    })()
  }, [readOnStart, reply?.id, reply?.text, sendTurn, stop])

  const mute = useCallback((value: boolean) => {
    setMuted(value); connection.current?.mute(value)
    if (value) setHeard("")
  }, [])

  const say = useCallback((text: string) => { setHeard(""); setPhase("thinking"); cutOff.current = null; sendTurn(text) }, [sendTurn])
  const levels = useCallback(() => ({ mic: connection.current?.level ?? 0, out: speechOutputLevel() }), [])
  const dismissError = useCallback(() => setError(""), [])

  return { phase, muted, error, heard, speaking, cut, start, stop, mute, say, dismissError, levels }
}

/** Whether the viewport is phone-sized, so the bar stacks around a larger orb. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    notify => { const query = window.matchMedia("(max-width: 639px)"); query.addEventListener("change", notify); return () => query.removeEventListener("change", notify) },
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false,
  )
}

/** The state as words; muting and talking over a reply have their own. */
function label(session: VoiceSession): string {
  if (session.muted) return "Muted"
  switch (session.phase) {
    case "starting": return "Getting voice ready on your Mac…"
    case "hearing": return session.cut ? "Stopped · hearing you" : "Hearing you"
    case "thinking": return "Thinking"
    case "speaking": return "Speaking · talk to interrupt"
    default: return "Listening"
  }
}

/** The orb's motion for the session's state. */
function orbState(session: VoiceSession): OrbState {
  if (session.muted && session.phase !== "speaking") return "idle"
  return session.phase === "off" ? "idle" : session.phase
}

/** The caption under the label: what's being said, by whom, or a hint for what to say. */
function Caption({ session, hint }: { session: VoiceSession; hint: string }) {
  const { phase, heard, speaking, cut, muted } = session
  if (muted) return <>Tap the mic to talk again.</>
  if (phase === "starting") return <>Loading the speech models. The first time in a while takes a few seconds.</>
  if (phase === "hearing")
    return (
      <>
        {cut ? (
          <span className="block text-muted-foreground">
            …{cut.heard} <s className="decoration-muted-foreground/60">{cut.unheard}</s>
          </span>
        ) : null}
        {heard || <span className="text-muted-foreground">…</span>}
      </>
    )
  if (phase === "thinking") return heard ? <>&ldquo;{heard}&rdquo;</> : <span className="text-muted-foreground">One moment…</span>
  if (phase === "speaking" && speaking) return <>{speaking}</>
  return <span className="text-muted-foreground">{hint}</span>
}

/** A round icon button in the bar. */
function BarButton({ label: text, onClick, icon, className, pressed }: {
  label: string
  onClick: () => void
  icon: typeof Mic01Icon
  className?: string
  pressed?: boolean
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={text}
      title={text}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn("size-11 shrink-0 rounded-full", className)}
    >
      <HugeiconsIcon icon={icon} size={18} aria-hidden="true" />
    </Button>
  )
}

/**
 * The voice bar, in the composer's place while a session is on: the orb, what it's doing, the
 * words being said or heard, then mute, an optional next step, and end. On a phone it stacks
 * around a larger orb. Keys while it has the page: Space mutes, N goes next, Escape ends.
 */
export function VoiceBar({ session, hint, onNext, nextLabel = "Next section", onTypeInstead }: {
  session: VoiceSession
  hint: string
  onNext?: () => void
  nextLabel?: string
  onTypeInstead?: () => void
}) {
  const narrow = useNarrow()
  const { phase, muted, mute, stop } = session
  useEffect(() => {
    if (phase === "off") return
    /** Leaves keys alone while the learner types or presses a focused control. */
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || target?.closest("input, textarea, [contenteditable=true], button, [role=menuitem]")) return
      if (event.key === "Escape") { event.preventDefault(); stop() }
      else if (event.key === " ") { event.preventDefault(); mute(!muted) }
      else if ((event.key === "n" || event.key === "N") && onNext) { event.preventDefault(); onNext() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [phase, muted, mute, stop, onNext])

  const controls = (
    <div className="flex shrink-0 items-center gap-2">
      <BarButton
        label={muted ? "Unmute" : "Mute"}
        icon={muted ? MicOff01Icon : Mic01Icon}
        pressed={muted}
        onClick={() => mute(!muted)}
        className={muted ? "border-destructive/40 text-destructive" : undefined}
      />
      {onNext ? <BarButton label={nextLabel} icon={NextIcon} onClick={onNext} /> : null}
      <BarButton
        label="End voice"
        icon={Cancel01Icon}
        onClick={stop}
        className="border-transparent bg-destructive text-white hover:bg-destructive/90 hover:text-white dark:border-transparent dark:bg-destructive dark:hover:bg-destructive/90"
      />
    </div>
  )
  const status = (
    <p role="status" aria-live="polite" className={cn("text-sm font-medium", muted ? "text-muted-foreground" : "text-brand")}>
      {label(session)}
    </p>
  )
  const caption = (
    <div className={cn("text-[0.95rem] leading-snug text-foreground", narrow ? "line-clamp-4 text-center" : "line-clamp-2")}>
      <Caption session={session} hint={hint} />
    </div>
  )
  const typeInstead = onTypeInstead ? (
    <button
      type="button"
      onClick={onTypeInstead}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground hover:text-foreground"
    >
      <HugeiconsIcon icon={KeyboardIcon} size={16} aria-hidden="true" />
      Type instead
    </button>
  ) : null

  if (narrow)
    return (
      <div role="group" aria-label="Voice" className="relative flex flex-col items-center gap-2 rounded-3xl border bg-card px-4 pt-3 pb-4 shadow-sm">
        {typeInstead ? <div className="absolute top-1 right-1">{typeInstead}</div> : null}
        <VoiceOrb size={104} state={orbState(session)} levels={session.levels} />
        {status}
        <div className="min-h-[2.75rem] w-full">{caption}</div>
        {controls}
      </div>
    )
  return (
    <div role="group" aria-label="Voice" className="flex items-center gap-3 rounded-3xl border bg-card py-2 pr-3 pl-2 shadow-sm">
      <VoiceOrb size={64} state={orbState(session)} levels={session.levels} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">{status}</div>
        {caption}
      </div>
      {typeInstead}
      {controls}
    </div>
  )
}

/** A start failure in the composer's place, with a retry and a way back to typing. */
export function VoiceError({ session, onTypeInstead }: { session: VoiceSession; onTypeInstead?: () => void }) {
  if (!session.error || session.phase !== "off") return null
  return (
    <div role="alert" className="mb-2 rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
      <p className="text-foreground">{session.error}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" className="min-h-11 rounded-full" onClick={session.start}>Try again</Button>
        <Button type="button" size="sm" variant="ghost" className="min-h-11 rounded-full" onClick={() => { session.dismissError(); onTypeInstead?.() }}>
          Type instead
        </Button>
      </div>
    </div>
  )
}

/** Starts a spoken conversation: a pill beside the composer's mic, or a header button in Teach. */
export function TalkButton({ session, children = "Talk", disabled, className }: {
  session: VoiceSession
  children?: React.ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled || session.phase !== "off"}
      onClick={session.start}
      className={cn("min-h-11 shrink-0 gap-1.5 rounded-full px-3.5", className)}
    >
      <HugeiconsIcon icon={AudioWave01Icon} size={16} aria-hidden="true" />
      {children}
    </Button>
  )
}
