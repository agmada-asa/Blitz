/**
 * Buffers one microphone connection's PCM and turns it into transcripts. The voice service owns sockets,
 * workers and logging; this file owns the turn rules, so muting, stopping and speculative transcription
 * can be tested without a microphone, Whisper or a socket.
 */

/** Side effects a turn needs from the owning connection. */
export type VoiceTurnHost = {
  /** Transcribes a PCM16 snapshot; rejects on failure. */
  transcribe(pcm: Buffer): Promise<string>
  /** Sends one protocol message to the browser. */
  send(value: object): void
  /** Tells the turn detector the current turn has ended. */
  endTurn(): void
  /** Records a finished transcript in the private diagnostics log. */
  log(value: object): void
  /** Reports a failure that ends the connection. */
  fail(error: unknown): void
  /** True once the socket has closed, so late results are dropped. */
  closed(): boolean
}

/** Longest turn kept in memory: two minutes of 16 kHz PCM16. */
const MAX_TURN_BYTES = 16000 * 2 * 120
/** Pre-roll kept before speech starts in voice mode: half a second. */
const PRE_ROLL_BYTES = 16000

/** Turn state for one connection. A reset bumps the generation so in-flight transcripts are never emitted. */
export class VoiceTurns {
  mode: "voice" | "dictate" = "dictate"
  /** True after Silero heard speech in the current turn. */
  active = false
  private frames: Buffer[] = []
  private bytes = 0
  /** True while the current turn is being transcribed; new audio is not buffered or sent to the detector. */
  transcribing = false
  private generation = 0
  private early?: Promise<string>
  private voicedAt = 0
  private host: VoiceTurnHost

  /** @param host Side effects owned by the socket connection. */
  constructor(host: VoiceTurnHost) { this.host = host }

  /**
   * Adds one microphone frame. Frames that arrive while a turn is being transcribed are ignored.
   * @returns False when the frame ended the connection (bad audio or an overlong turn).
   */
  audio(frame: Buffer): boolean {
    if (this.transcribing) return true
    if (frame.length % 2) { this.host.fail(new Error("Invalid microphone audio.")); return false }
    this.frames.push(frame); this.bytes += frame.length
    if (this.bytes > MAX_TURN_BYTES) { this.host.fail(new Error("Keep each turn under two minutes.")); return false }
    // Keep just pre-roll until Silero detects speech.
    if (this.mode !== "dictate" && !this.active && this.bytes > PRE_ROLL_BYTES) {
      this.frames = [Buffer.concat(this.frames).subarray(-PRE_ROLL_BYTES)]; this.bytes = PRE_ROLL_BYTES
    }
    return true
  }

  /** Marks speech starting or resuming; any speculative transcript is now out of date. */
  speech(): void { this.active = true; this.early = undefined; this.voicedAt = Date.now() }

  /** Starts a speculative transcript at a pause in speech so a confirmed turn can reply sooner. */
  pause(): void {
    if (this.active && Date.now() - this.voicedAt >= 96) {
      this.early = this.host.transcribe(Buffer.concat(this.frames))
      this.early.catch(() => undefined)
    }
  }

  /**
   * Discards buffered audio and any transcript still in progress, as when the learner mutes.
   * A transcription that finishes after this is dropped rather than sent as the learner's words.
   */
  reset(): void {
    this.generation++
    this.frames = []; this.bytes = 0; this.active = false; this.early = undefined
    // New audio is accepted at once; the stale transcription can no longer finish this turn,
    // so the browser stops showing it as thinking.
    if (this.transcribing && !this.host.closed()) this.host.send({ type: "state", state: "listening" })
    this.transcribing = false
    this.host.endTurn()
  }

  /**
   * Takes the buffered turn and sends its transcript. In dictation an empty recording still answers,
   * with empty text, so the composer leaves its transcribing state instead of waiting forever.
   */
  async take(): Promise<void> {
    if (this.transcribing) return
    if (!this.bytes) {
      if (this.mode === "dictate" && !this.host.closed()) this.host.send({ type: "user", text: "" })
      return
    }
    this.transcribing = true
    const generation = this.generation
    const pcm = Buffer.concat(this.frames)
    const early = this.early
    this.frames = []; this.bytes = 0; this.active = false; this.early = undefined
    this.host.endTurn()
    const start = Date.now()
    this.host.send({ type: "state", state: "thinking" })
    try {
      const text = await (early || this.host.transcribe(pcm))
      if (generation !== this.generation || this.host.closed()) return
      if (text.trim() || this.mode === "dictate") {
        this.host.send({ type: "user", text })
        this.host.log({ transcript: text, transcriptionMs: Date.now() - start, mode: this.mode })
      } else this.host.send({ type: "state", state: "listening" })
    } catch (error) {
      if (generation === this.generation && !this.host.closed()) this.host.fail(error)
    } finally {
      if (generation === this.generation) this.transcribing = false
    }
  }

  /** Drops all audio when the connection closes. */
  clear(): void { this.generation++; this.frames = []; this.bytes = 0; this.early = undefined }
}
