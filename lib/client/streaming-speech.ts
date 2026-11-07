/** Feeds growing Markdown through the existing cancellable, gapless speech player. */
import { pieceEnd, speakablePieces } from "../speech-pieces.ts"
import { spokenMarkdownText } from "../spoken-markdown.ts"
import { playSpeechSections } from "./speech-playback.ts"

/** One growing reply. Unread text may change; rewriting consumed text stops playback. */
export class StreamingSpeech {
  private text = ""
  private consumed = 0
  private tail: Promise<void> | undefined
  private queue: string[] = []
  private wake: (() => void) | undefined
  private complete = false
  failed = false
  private completed = ""
  private current: { text: string; at: number; ms: number } | undefined
  private controller = new AbortController()
  /** Pieces still to pass over, when resuming a reply part-way through. */
  private skip: number
  /** Pieces skipped or played to the end, so a later reader can resume after them. */
  played = 0

  private voiceId: string
  private state: (state: "loading" | "playing") => void
  private error: (error: unknown) => void
  private onHeard?: (synthesisMs: number) => void
  /** Called with each piece's text as it starts playing, for the voice bar's caption. */
  onSpeaking?: (text: string) => void

  /**
   * Selects the saved voice and reports playback state and failures to its owning screen.
   * @param skip Pieces already heard, so a reply that was stopped resumes at the piece it was cut in.
   */
  constructor(
    voiceId: string,
    state: (state: "loading" | "playing") => void,
    error: (error: unknown) => void,
    onHeard?: (synthesisMs: number) => void,
    skip = 0,
  ) {
    this.voiceId = voiceId
    this.state = state
    this.error = error
    this.onHeard = onHeard
    this.skip = skip
  }

  /** Queues only complete pieces, flushing the final remainder after generation completes. */
  update(text: string, complete: boolean): void {
    // Streamed metadata may disappear before it is spoken. Only consumed text is immutable.
    if (!text.startsWith(this.text.slice(0, this.consumed))) { this.stop(); return }
    this.text = text
    while (!this.controller.signal.aborted) {
      const pending = text.slice(this.consumed)
      const boundary = pieceEnd(pending)
      const end = boundary >= 0 ? boundary : complete ? pending.length : 0
      if (!end) break
      this.consumed += end
      const words = spokenMarkdownText(pending.slice(0, end))
      if (!words.trim()) continue
      // Whole sentences keep Kokoro's intonation intact; only overlong ones are split, at a clause.
      for (const piece of speakablePieces(words)) {
        if (this.skip > 0) { this.skip--; this.played++ } else this.queue.push(piece)
      }
    }
    this.complete = complete
    this.wake?.()
    this.tail ??= playSpeechSections(this.pieces(), this.voiceId, this.controller.signal, this.state, (text, ms, phase, synthesisMs) => {
      if (phase === "playing") { this.current = { text, at: performance.now(), ms }; this.onHeard?.(synthesisMs); this.onSpeaking?.(text) }
      else { this.completed += text + " "; this.current = undefined; this.played++ }
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
    return (this.completed + (this.split()?.heard ?? "")).trim()
  }

  /** The piece playing now, split into the words already heard and the rest; null between pieces. */
  split(): { heard: string; unheard: string } | null {
    const current = this.current
    if (!current) return null
    const words = current.text.split(/\s+/)
    const fraction = Math.max(0, Math.min(1, (performance.now() - current.at) / current.ms))
    const at = Math.floor(words.length * fraction)
    return { heard: words.slice(0, at).join(" "), unheard: words.slice(at).join(" ") }
  }

  /** Whether this reader was stopped before the end. */
  get stopped(): boolean { return this.controller.signal.aborted }

  /** Cancels queued inference and playback immediately. */
  stop(): void { this.controller.abort(); this.wake?.() }
}
