/** Feeds growing Markdown through the existing cancellable, gapless speech player. */
import { pieceEnd } from "../speech-pieces.ts"
import { spokenMarkdownText } from "../spoken-markdown"
import { playSpeechSections } from "./speech-playback"

/** One growing reply. Updates must preserve the existing prefix; stop on rewrites or navigation. */
export class StreamingSpeech {
  private text = ""
  private consumed = 0
  private first = true
  private tail: Promise<void> | undefined
  private queue: string[] = []
  private wake: (() => void) | undefined
  private complete = false
  failed = false
  private completed = ""
  private current: { text: string; at: number; ms: number } | undefined
  private controller = new AbortController()

  /** Selects the saved voice and reports playback state and failures to its owning screen. */
  constructor(
    private voiceId: string,
    private state: (state: "loading" | "playing") => void,
    private error: (error: unknown) => void,
    private onHeard?: (synthesisMs: number) => void,
  ) {}

  /** Queues only complete pieces, flushing the final remainder after generation completes. */
  update(text: string, complete: boolean): void {
    if (!text.startsWith(this.text)) { this.stop(); return }
    this.text = text
    while (!this.controller.signal.aborted) {
      const pending = text.slice(this.consumed)
      const boundary = pieceEnd(pending, this.first)
      const end = boundary >= 0 ? boundary : complete ? pending.length : 0
      if (!end) break
      this.consumed += end
      const words = spokenMarkdownText(pending.slice(0, end))
      if (!words.trim()) continue
      this.first = false
      this.queue.push(words)
    }
    this.complete = complete
    this.wake?.()
    this.tail ??= playSpeechSections(this.pieces(), this.voiceId, this.controller.signal, this.state, (text, ms, phase, synthesisMs) => {
      if (phase === "playing") { this.current = { text, at: performance.now(), ms }; this.onHeard?.(synthesisMs) }
      else { this.completed += text + " "; this.current = undefined }
    })
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) { this.failed = true; this.error(error); this.stop() }
      })
  }

  /** Yields pieces as generation advances, keeping the player's bounded synthesis lookahead. */
  private async *pieces(): AsyncGenerator<string> {
    while (!this.controller.signal.aborted) {
      if (this.queue.length) { yield this.queue.shift()!; continue }
      if (this.complete) return
      await new Promise<void>(resolve => { this.wake = resolve })
    }
  }

  /** Resolves when every queued piece has finished playing. */
  done(): Promise<void> { return this.tail ?? Promise.resolve() }
  /** Whether this reply still has speech to generate or play. */
  get active(): boolean { return !this.controller.signal.aborted && (!this.complete || !!this.current || this.queue.length > 0) }

  /** Estimates heard words in the current piece from actual playback time, plus completed pieces. */
  heard(): string {
    const current = this.current
    if (!current) return this.completed.trim()
    const words = current.text.split(/\s+/)
    const fraction = Math.max(0, Math.min(1, (performance.now() - current.at) / current.ms))
    return (this.completed + words.slice(0, Math.floor(words.length * fraction)).join(" ")).trim()
  }

  /** Cancels queued inference and playback immediately. */
  stop(): void { this.controller.abort(); this.wake?.() }
}
