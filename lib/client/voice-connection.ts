/** Connects browser microphone packets to the local voice service with explicit lifecycle ownership. */
import { openMic, type Mic } from "./voice-mic"

/** Protocol events consumed by dictation and continuous conversation controls. */
export type VoiceEvent = { type: string; text?: string; state?: string; message?: string }

/** Owns a socket and microphone, releasing both on errors, cancellation, or a hidden page. */
export class VoiceConnection {
  private socket?: WebSocket
  private mic?: Mic
  private closed = false
  private muted = false
  private readyTimer?: ReturnType<typeof setTimeout>
  private visibility = () => { if (document.hidden) this.close() }

  /** Reports speech events and dropped connections to the owning control. */
  constructor(private receive: (event: VoiceEvent) => void) {}

  /** Warms models before opening the microphone. A cancelled start never retains late permission grants. */
  async start(mode: "voice" | "dictate", prompt = ""): Promise<void> {
    if (!window.isSecureContext) throw new Error("Open the app over HTTPS to use the microphone on your phone.")
    const response = await fetch("/api/audio/voice")
    if (!response.ok) throw new Error("Voice could not connect. Try again.")
    const { url } = await response.json()
    if (this.closed) return
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
    if (this.closed) return
    const mic = await openMic(packet => {
      if (this.muted) return
      if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 128_000) {
        this.receive({ type: "error", message: "Voice connection is too slow. Reconnect." }); this.close(); return
      }
      this.socket.send(packet.buffer as ArrayBuffer)
    }, () => {})
    if (this.closed) mic.stop()
    else { this.mic = mic; document.addEventListener("visibilitychange", this.visibility) }
  }

  /** Stops capture for tap-to-stop dictation and requests its final transcript. */
  finish(): void { this.mic?.stop(); this.mic = undefined; this.send({ type: "stop" }) }
  /** Stops sending microphone packets while muted. */
  mute(value: boolean): void { this.mic?.mute(value); this.muted = value; this.send({ type: "reset" }) }
  /** Sends bounded reply text for the user's local diagnostics log. */
  send(value: object): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)) }
  /** Closes all resources, including a start still waiting for model readiness. */
  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.readyTimer)
    this.mic?.stop(); this.socket?.close()
    document.removeEventListener("visibilitychange", this.visibility)
    this.receive({ type: "closed" })
  }
}
