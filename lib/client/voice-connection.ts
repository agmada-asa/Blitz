/** Connects browser microphone packets to the local voice service with explicit lifecycle ownership. */
import { openMic, type Mic } from "./voice-mic.ts"

/** Protocol events consumed by dictation and continuous conversation controls. */
export type VoiceEvent = { type: string; text?: string; state?: string; message?: string }

/** Opens capture and reports 16 kHz PCM packets; replaceable so lifecycle rules can be tested without a device. */
export type MicOpener = (heard: (packet: Int16Array) => void, level: (rms: number) => void) => Promise<Mic>

/** Shown when the page is hidden before capture starts, so the learner knows why voice stopped. */
export const HIDDEN_START_MESSAGE = "Voice stopped because Blitz was in the background. Start it again when you're back."

/** Owns a socket and microphone, releasing both on errors, cancellation, or a hidden page. */
export class VoiceConnection {
  private socket?: WebSocket
  private mic?: Mic
  private closed = false
  private hidden = false
  private muted = false
  private readyTimer?: ReturnType<typeof setTimeout>
  private receive: (event: VoiceEvent) => void
  private open: MicOpener
  /** Latest microphone loudness (RMS, 0..1), read each frame by the voice bolt; 0 while muted. */
  level = 0
  /** Ends the session as soon as the page is hidden, including while models warm or permission is pending. */
  private visibility = () => { if (document.hidden) { this.hidden = true; this.close() } }

  /**
   * @param receive Reports speech events and dropped connections to the owning control.
   * @param open Opens the microphone; defaults to echo-cancelled browser capture.
   */
  constructor(receive: (event: VoiceEvent) => void, open: MicOpener = openMic) {
    this.receive = receive
    this.open = open
  }

  /**
   * Warms models before opening the microphone. A cancelled start never retains late permission grants,
   * and a page hidden at any point before capture starts ends the session without opening the microphone.
   * @throws When the service cannot start, or with {@link HIDDEN_START_MESSAGE} when the page was hidden.
   */
  async start(mode: "voice" | "dictate", prompt = ""): Promise<void> {
    if (!window.isSecureContext) throw new Error("Open the app over HTTPS to use the microphone on your phone.")
    // Watch visibility before any slow step: warming can take minutes and the learner may switch tabs.
    document.addEventListener("visibilitychange", this.visibility)
    this.visibility()
    this.ensureVisible()
    if (this.closed) return
    const response = await fetch("/api/audio/voice")
    if (!response.ok) throw new Error("Voice could not connect. Try again.")
    const { url } = await response.json()
    this.ensureVisible()
    if (this.closed) return
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url)
        this.socket = socket
        let ready = false
        this.readyTimer = setTimeout(() => {
          reject(new Error("Speech took too long to start. Check the local speech setup and retry."))
          this.close()
        }, 20 * 60_000)
        socket.onopen = () => socket.send(JSON.stringify({ type: "start", mode, prompt: prompt.slice(-2000) }))
        socket.onerror = () => { reject(new Error("Voice could not connect. Start the local voice service and retry.")); this.close() }
        socket.onclose = () => {
          if (!ready) reject(new Error("Voice connection closed. Try again."))
          if (!this.closed) this.receive({ type: "error", message: "Lost the connection to your Mac. Reconnect or continue by typing." })
          this.close()
        }
        socket.onmessage = event => {
          const message = JSON.parse(event.data) as VoiceEvent
          if (message.type === "ready") { ready = true; clearTimeout(this.readyTimer); resolve() }
          else if (message.type === "error" && !ready) { reject(new Error(message.message)); this.close() }
          else this.receive(message)
        }
      })
    } catch (error) {
      this.ensureVisible()
      throw error
    }
    this.ensureVisible()
    if (this.closed) return
    const mic = await this.open(packet => {
      // Packets already queued by the audio thread are dropped once muted or hidden.
      if (this.muted || this.closed || document.hidden) return
      if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 128_000) {
        this.receive({ type: "error", message: "Voice connection is too slow. Reconnect." }); this.close(); return
      }
      this.socket.send(packet.buffer as ArrayBuffer)
    }, rms => { this.level = this.muted ? 0 : rms })
    // A permission prompt can outlast a tab switch; release a late grant instead of recording in the background.
    if (this.closed || document.hidden) { mic.stop(); this.close(); this.ensureVisible(); return }
    this.mic = mic
  }

  /** Stops capture for tap-to-stop dictation and requests its final transcript. */
  finish(): void { this.mic?.stop(); this.mic = undefined; this.send({ type: "stop" }) }
  /** Stops sending microphone packets while muted; the service discards any turn still being transcribed. */
  mute(value: boolean): void { this.mic?.mute(value); this.muted = value; this.send({ type: "reset" }) }
  /** Sends bounded reply text for the user's local diagnostics log. */
  send(value: object): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)) }
  /** Closes all resources, including a start still waiting for model readiness. */
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.readyTimer)
    this.mic?.stop(); this.mic = undefined; this.socket?.close()
    document.removeEventListener("visibilitychange", this.visibility)
    this.receive({ type: "closed" })
  }

  /** Throws the background message when a hidden page ended this start, so callers can explain it. */
  private ensureVisible(): void {
    if (this.hidden) throw new Error(HIDDEN_START_MESSAGE)
  }
}
