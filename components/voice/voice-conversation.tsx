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
import { VoiceBolt, type BoltState } from "@/components/voice/voice-bolt"
import { VoiceConnection } from "@/lib/client/voice-connection"
import { StreamingSpeech } from "@/lib/client/streaming-speech"
import { duckSpeech, speechOutputLevel, unlockSpeech } from "@/lib/client/speech-playback"
import { cn } from "@/lib/utils"

/** What a voice session is doing. */
export type VoicePhase = "off" | "starting" | "listening" | "hearing" | "thinking" | "speaking"

/** The reply being read: its id, the text so far, and whether it has finished. */
export type VoiceReply = { id: string; text: string; complete: boolean } | null

/** The learner talked over a reply: what they heard of it, empty if they spoke before it began. */
export type VoiceCut = { heard: string }

/** Tells the model, alongside the learner's words, how much of its last spoken reply they heard. */
export function voiceCutNote(cut: VoiceCut | null): string {
  if (!cut) return ""
  return cut.heard
    ? `The learner cut in while your last reply was being read aloud. They heard only: "${cut.heard.slice(-2000)}". Carry on from what they say now.`
    : "The learner said this before hearing any of your last reply, which was stopped. Answer their last two messages together."
}

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
  /** A turn sent through the owning screen failed: shows why and carries on with the reply it stopped. */
  report: (message: string) => void
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
export function useVoiceSession({ onTurn, onInterrupt, reply, busy, readOnStart = false, onReplyDone }: {
  /**
   * Sends the learner's words. `cut` is set when they talked over a reply: `heard` is how much of it
   * they heard, empty when they spoke again before any of it.
   */
  onTurn: (text: string, cut: VoiceCut | null) => Promise<unknown>
  /** Stops the reply still being written when the learner talks over it. Without it, it keeps writing. */
  onInterrupt?: () => void
  /** The reply to read. A reply read before, then stopped, resumes at the sentence it was cut in. */
  reply: VoiceReply
  /** A reply is being written; a turn waits for it to finish or stop. */
  busy: boolean
  /** Read the latest reply as soon as voice starts, instead of only new ones. */
  readOnStart?: boolean
  /** A reply has been read to its end. */
  onReplyDone?: (id: string) => void
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
  const pending = useRef<{ text: string; cut: VoiceCut | null } | null>(null)
  const callbacks = useRef({ onTurn, onInterrupt, onReplyDone, busy, muted })
  const release = useRef<(() => void) | null>(null)
  const mounted = useRef(true)
  const session = useRef(0)
  /** Set when the learner talked over a reply, until their words go out with it. */
  const cutOff = useRef<VoiceCut | null>(null)
  /** Pieces of each reply already heard, so a reply that was stopped resumes where it was cut. */
  const progress = useRef(new Map<string, number>())
  /** A turn went out and its reply hasn't started being read. */
  const awaiting = useRef(false)
  const watched = useRef<StreamingSpeech | null>(null)
  /** Bumped to rebuild a stopped reader, so its reply carries on from saved progress. */
  const [resumed, setResumed] = useState(0)
  const turnAt = useRef(0)
  const wakeLock = useRef<WakeLockSentinel | null>(null)
  // Event callbacks see the current turn state without reopening the microphone.
  useEffect(() => { callbacks.current = { onTurn, onInterrupt, onReplyDone, busy, muted } })

  /** Stops the reader, remembering how far it got so the same reply can resume later. */
  const stopReading = useCallback(() => {
    const current = reader.current
    if (current && readingId.current) progress.current.set(readingId.current, current.played)
    current?.stop()
    duckSpeech(false)
  }, [])

  /** Releases capture, speech, wake lock and queued unsent words. */
  const stop = useCallback(() => {
    session.current++
    connection.current?.close(); connection.current = null
    reader.current?.stop(); reader.current = null
    duckSpeech(false)
    release.current?.(); release.current = null
    void wakeLock.current?.release(); wakeLock.current = null
    pending.current = null; readingId.current = ""; cutOff.current = null; awaiting.current = false
    progress.current.clear()
    // An earlier turn's failure doesn't outlive the session; a failure that ends it is set after this.
    setPhase("off"); setMuted(false); setHeard(""); setSpeaking(""); setCut(null); setError("")
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Cleared so a start still waiting on the permission prompt doesn't take a wake lock afterwards.
      connection.current?.close(); connection.current = null
      reader.current?.stop(); duckSpeech(false); release.current?.(); void wakeLock.current?.release()
    }
  }, [])

  /**
   * Carries on with a reply that was stopped for words that never became a sent turn: noise after
   * all, words thrown away by muting, or a turn that failed to send.
   */
  const resume = useCallback(() => {
    cutOff.current = null; awaiting.current = false
    const current = reader.current
    if (current?.stopped && !current.failed) { readingId.current = ""; setResumed(count => count + 1) }
  }, [])

  /** Shows why a turn didn't go out and goes back to listening. */
  const turnFailed = useCallback((caught: unknown) => {
    setError(caught instanceof Error && caught.message ? caught.message : "Your turn failed. Try again.")
    setHeard(""); setPhase("listening")
    resume()
  }, [resume])

  /** Sends a turn now, or holds it until the reply being written has finished or stopped. */
  const sendTurn = useCallback((text: string, cut: VoiceCut | null) => {
    turnAt.current = performance.now()
    awaiting.current = true
    setError("")
    stopReading()
    if (callbacks.current.busy) {
      // A second turn while the first is held joins it rather than replacing it.
      const held = pending.current
      pending.current = held ? { text: `${held.text} ${text}`, cut: held.cut ?? cut } : { text, cut }
      return
    }
    void callbacks.current.onTurn(text, cut).catch(turnFailed)
  }, [stopReading, turnFailed])

  // Reads the reply as it grows; a new reply id starts a new reader, resuming where that reply was cut.
  useEffect(() => {
    if (phase === "off" || phase === "starting" || !reply) return
    if (readingId.current !== reply.id) {
      stopReading()
      const id = reply.id
      const current = new StreamingSpeech(settings?.voiceIds?.[0] ?? "af_heart", next => {
        if (reader.current !== current) return
        if (next === "playing") awaiting.current = false
        setPhase(next === "playing" ? "speaking" : "thinking")
      }, caught => setError(caught instanceof Error ? caught.message : "Speech failed. Try again."), synthesisMs => {
        connection.current?.send({ type: "timing", heardMs: performance.now() - turnAt.current, synthesisMs })
      }, progress.current.get(id) ?? 0)
      current.onSpeaking = text => { if (reader.current === current) { setSpeaking(text); setCut(null) } }
      reader.current = current
      readingId.current = id
    }
    const current = reader.current
    current?.update(reply.text, reply.complete)
    if (reply.complete && current && watched.current !== current) {
      watched.current = current
      const id = reply.id
      void current.done().then(() => {
        if (current.failed || current.stopped || reader.current !== current || !connection.current) return
        progress.current.set(id, current.played)
        awaiting.current = false
        setPhase("listening"); setSpeaking("")
        callbacks.current.onReplyDone?.(id)
      })
      if (loggedReply.current !== reply.id) {
        loggedReply.current = reply.id
        connection.current?.send({ type: "reply", text: reply.text.slice(0, 6000) })
      }
    }
  }, [reply, settings, phase, stopReading, resumed])

  // A turn held while the last reply was being written or stopped goes out once it has.
  useEffect(() => {
    if (!busy && pending.current && connection.current) {
      const { text, cut } = pending.current; pending.current = null
      void onTurn(text, cut).catch(turnFailed)
    }
  }, [busy, onTurn, phase, turnFailed])

  /** Opens audio on the learner's gesture, then starts one microphone session. */
  const start = useCallback(() => {
    setError(""); setPhase("starting"); setHeard(""); setSpeaking(""); setCut(null)
    unlockSpeech()
    readingId.current = readOnStart ? "" : reply?.id ?? ""
    const generation = ++session.current
    release.current = claimReadAloud(() => reader.current?.stop())
    const socket = new VoiceConnection(event => {
      if (!mounted.current || generation !== session.current) return
      if (event.type === "error") { stop(); setError(event.message || "Voice failed.") }
      if (event.type === "closed") { if (connection.current === socket) stop() }
      if (callbacks.current.muted) return
      const reading = Boolean(reader.current?.active)
      if (event.type === "state" && event.state) {
        // Something that may be the learner turns the reply down; it stops only for real words
        // (`interrupt`), and comes back up if it was only noise.
        if (event.state === "hearing") { if (reading) duckSpeech(true); setPhase("hearing"); setHeard("") }
        else if (event.state === "thinking") { if (!reading) setPhase("thinking") }
        else {
          duckSpeech(false)
          setPhase(reading ? "speaking" : awaiting.current ? "thinking" : "listening")
          if (!reading) setHeard("")
        }
      }
      if (event.type === "caption" && typeof event.text === "string") setHeard(event.text)
      // The words that stopped the reply turned out to be noise: no turn follows, so it carries on.
      if (event.type === "dropped" && cutOff.current && !awaiting.current) resume()
      if (event.type === "interrupt") {
        const writing = callbacks.current.busy
        if (!reading && !writing) return
        const split = reader.current?.split() ?? null
        cutOff.current = { heard: reading ? reader.current?.heard() ?? "" : "" }
        if (split?.unheard) setCut(split)
        stopReading()
        if (writing) callbacks.current.onInterrupt?.()
      }
      if (event.type === "user" && event.text) {
        const words = event.text.trim()
        setHeard(words); setPhase("thinking")
        const cut = cutOff.current
        cutOff.current = null
        sendTurn(words, cut)
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
  }, [readOnStart, reply?.id, reply?.text, sendTurn, stop, stopReading, resume])

  const mute = useCallback((value: boolean) => {
    setMuted(value); connection.current?.mute(value)
    if (!value) return
    // Muting throws away a turn being heard: the reply comes back up, and carries on if it was stopped.
    setHeard(""); duckSpeech(false)
    if (cutOff.current && !awaiting.current) resume()
  }, [resume])

  const say = useCallback((text: string) => { setHeard(""); setPhase("thinking"); cutOff.current = null; sendTurn(text, null) }, [sendTurn])
  const report = useCallback((message: string) => turnFailed(new Error(message)), [turnFailed])
  // A failed turn's message clears itself during the session; one that ended it stays with Try again.
  const live = phase !== "off"
  useEffect(() => {
    if (!error || !live) return
    const timer = setTimeout(() => setError(""), 8000)
    return () => clearTimeout(timer)
  }, [error, live])
  const levels = useCallback(() => ({ mic: connection.current?.level ?? 0, out: speechOutputLevel() }), [])
  const dismissError = useCallback(() => setError(""), [])

  return { phase, muted, error, heard, speaking, cut, start, stop, mute, say, report, dismissError, levels }
}

/** Whether the viewport is phone-sized, so the bar stacks around a larger bolt. */
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

/** The bolt's motion for the session's state. */
function boltState(session: VoiceSession): BoltState {
  if (session.muted && session.phase !== "speaking") return "idle"
  return session.phase === "off" ? "idle" : session.phase
}

/** The caption under the label: what's being said, by whom, or a hint for what to say. */
function Caption({ session, hint }: { session: VoiceSession; hint: string }) {
  const { phase, heard, speaking, cut, muted, error } = session
  if (muted) return <>Tap the mic to talk again.</>
  // A failed turn shows until the learner speaks or a few seconds pass, even as a reply resumes.
  if (error && phase !== "hearing") return <span className="text-destructive">{error}</span>
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
 * The voice bar, in the composer's place while a session is on: the bolt, what it's doing, the
 * words being said or heard, then mute, an optional next step, and end. On a phone it stacks
 * around a larger bolt. Keys while it has the page: Space mutes, N goes next, Escape ends.
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
        <VoiceBolt size={104} state={boltState(session)} levels={session.levels} />
        {status}
        <div className="min-h-[2.75rem] w-full">{caption}</div>
        {controls}
      </div>
    )
  return (
    <div role="group" aria-label="Voice" className="flex items-center gap-3 rounded-3xl border bg-card py-2 pr-3 pl-2 shadow-sm">
      <VoiceBolt size={64} state={boltState(session)} levels={session.levels} />
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
