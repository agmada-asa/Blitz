"use client"

/** Hands-free voice controls shared by chat, lessons and short quizzes; the owning screen persists turns. */
import { useEffect, useRef, useState } from "react"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { claimReadAloud } from "@/components/chat/read-aloud-button"
import { VoiceConnection } from "@/lib/client/voice-connection"
import { StreamingSpeech } from "@/lib/client/streaming-speech"
import { unlockSpeech } from "@/lib/client/speech-playback"

/** Starts continuous listening, reads growing replies, and interrupts only within this explicit voice session. */
export function VoiceConversation({ onTurn, onInterrupt, reply, busy, disabled = false, readOnStart = false, onActiveChange }: {
  onActiveChange?: (active: boolean) => void
  readOnStart?: boolean
  onTurn: (text: string) => Promise<unknown>
  onInterrupt: () => void
  reply: { id: string; text: string; complete: boolean } | null
  busy: boolean
  disabled?: boolean
}) {
  const settings = useQuery(api.audioSettings.get)
  const [state, setState] = useState("off")
  const [error, setError] = useState("")
  const [muted, setMuted] = useState(false)
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

  /** Releases capture, speech, wake lock ownership and queued unsent words. */
  function stop(): void {
    session.current++
    connection.current?.close(); connection.current = null
    reader.current?.stop(); reader.current = null
    release.current?.(); release.current = null
    void wakeLock.current?.release(); wakeLock.current = null
    pending.current = ""; readingId.current = ""
    setState("off"); setMuted(false)
    onActiveChange?.(false)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; connection.current?.close(); reader.current?.stop(); release.current?.(); void wakeLock.current?.release(); onActiveChange?.(false) }
  }, [onActiveChange])

  useEffect(() => {
    if (state === "off" || state === "starting" || !reply) return
    if (readingId.current !== reply.id) {
      reader.current?.stop()
      reader.current = new StreamingSpeech(settings?.voiceIds?.[0] ?? "af_heart", next => setState(next === "playing" ? "speaking" : "thinking"), caught => setError(caught instanceof Error ? caught.message : "Speech failed. Try again."), synthesisMs => {
        connection.current?.send({ type: "timing", heardMs: performance.now() - turnAt.current, synthesisMs })
      })
      readingId.current = reply.id
    }
    reader.current?.update(reply.text, reply.complete)
    if (reply.complete) {
      const current = reader.current
      void current?.done().then(() => { if (!current.failed && reader.current === current && connection.current) setState("listening") })
      if (loggedReply.current !== reply.id && current) {
        loggedReply.current = reply.id
        connection.current?.send({ type: "reply", text: reply.text.slice(0, 6000) })
      }
    }
  }, [reply, settings, state])

  useEffect(() => {
    if (!busy && pending.current && connection.current) {
      const text = pending.current; pending.current = ""
      void onTurn(text).catch(caught => setError(caught instanceof Error ? caught.message : "Your turn failed. Try again."))
    }
  }, [busy, onTurn, state])

  /** Opens audio on the user's gesture, then starts one microphone session. */
  async function start(): Promise<void> {
    setError(""); setState("starting")
    onActiveChange?.(true)
    unlockSpeech()
    readingId.current = readOnStart ? "" : reply?.id ?? ""
    const generation = ++session.current
    release.current = claimReadAloud(() => reader.current?.stop())
    const socket = new VoiceConnection(event => {
      if (!mounted.current || generation !== session.current) return
      if (event.type === "error") { setError(event.message || "Voice failed."); stop() }
      if (event.type === "closed") { connection.current = null; reader.current?.stop(); void wakeLock.current?.release(); release.current?.(); setState("off"); onActiveChange?.(false) }
      if (event.type === "state" && !callbacks.current.muted) setState(event.state || "listening")
      if (event.type === "interrupt" && !callbacks.current.muted) {
        if (!callbacks.current.busy && !reader.current?.active) return
        cutOff.current = reader.current?.heard() ?? ""
        reader.current?.stop()
        if (callbacks.current.busy) callbacks.current.onInterrupt()
      }
      if (event.type === "user" && event.text && !callbacks.current.muted) {
        turnAt.current = performance.now()
        const text = cutOff.current === null || readOnStart ? event.text : event.text +
          (cutOff.current ? '\n\n[Your previous reply was interrupted. The learner heard only: "' + cutOff.current.slice(-2000) + '".]' : "\n\n[The learner was still adding to the previous question; none of the reply was heard.]")
        cutOff.current = null
        reader.current?.stop()
        if (callbacks.current.busy) { pending.current = text; callbacks.current.onInterrupt() }
        else void callbacks.current.onTurn(text).catch(caught => setError(caught instanceof Error ? caught.message : "Your turn failed."))
      }
    })
    connection.current = socket
    try {
      await socket.start("voice", reply?.text ?? "")
      if (connection.current === socket) {
        setState("listening")
        if ("wakeLock" in navigator) {
          const lock = await navigator.wakeLock.request("screen").catch(() => null)
          if (connection.current === socket) wakeLock.current = lock
          else void lock?.release()
        }
      }
    } catch (caught) { if (generation === session.current) { setError(caught instanceof Error ? caught.message : "Microphone unavailable."); stop() } }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 py-2 [&_button]:min-h-11">
      {state === "off" ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => void start()}>Start voice</Button> : <>
        <p role="status" className="min-w-24 text-sm text-muted-foreground">{muted ? "Muted" : state === "starting" ? "Preparing speech…" : state === "speaking" ? "Speaking" : state === "thinking" ? "Thinking…" : state === "hearing" ? "Hearing you" : "Listening"}</p>
        <Button variant="outline" size="sm" disabled={state === "starting"} aria-pressed={muted} onClick={() => { setMuted(!muted); connection.current?.mute(!muted) }}> {muted ? "Unmute" : "Mute"} </Button>
        <Button variant="outline" size="sm" onClick={stop}>End voice</Button>
      </>}
      {error ? <p role="alert" className="basis-full text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
