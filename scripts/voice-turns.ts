/**
 * Buffers one microphone connection's PCM and turns it into transcripts. The voice service owns sockets,
 * workers and logging; this file owns the turn rules, so muting, stopping, live captions and speculative
 * transcription can be tested without a microphone, Whisper or a socket.
 *
 * Voice mode: each turn is one segment. Captions show that turn's words so far; `user` carries the final
 * words. Dictation: a detected end of turn commits the segment and listening carries on, so a long
 * dictation is transcribed in pieces. Captions show the whole dictation so far; `user` arrives on stop.
 */

/** Side effects a turn needs from the owning connection. */
export type VoiceTurnHost = {
  /**
   * Transcribes a PCM16 snapshot; rejects on failure.
   * @param context Words already dictated just before this audio, to keep segments continuous.
   */
  transcribe(pcm: Buffer, context?: string): Promise<string>
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

/** Tuning that tests can shorten. */
export type VoiceTurnOptions = {
  /** Time between live caption transcriptions while speech continues. */
  captionMs?: number
  /** How long a turn that is only an opener waits for more. */
  openerMs?: number
}

/** Bytes per second of 16 kHz PCM16. */
const BYTES_PER_SECOND = 16000 * 2
/** Longest segment kept in memory: two minutes. */
const MAX_TURN_BYTES = BYTES_PER_SECOND * 120
/** Pre-roll kept before speech starts: half a second. */
const PRE_ROLL_BYTES = BYTES_PER_SECOND / 2
/** Shortest audio worth a live caption; less than this is usually a syllable Whisper guesses at. */
const MIN_CAPTION_BYTES = BYTES_PER_SECOND * 0.4
/** Live captions transcribe at most the last 20 s, so each stays well under a second of Whisper. */
const MAX_CAPTION_BYTES = BYTES_PER_SECOND * 20
/** A dictation segment this long without a pause is committed anyway, bounding each transcription. */
const FORCE_COMMIT_BYTES = BYTES_PER_SECOND * 25
/** Committed words passed to Whisper as context for the next segment. */
const CONTEXT_CHARS = 300

/** How long a turn that is only an opener ("Okay.", "Um, so") waits for the learner to go on. */
const OPENER_WAIT_MS = 1000

/** Joins transcript pieces with single spaces, skipping empty ones. */
function join(...parts: string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join(" ")
}

/** The transcript's words, lowercased, without punctuation. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
}

/**
 * Phrases Whisper writes for noise, music or a voice across the room rather than for anything said
 * to it. Alone they are dropped; inside a longer turn they are kept.
 */
const INVENTED = new Set([
  "you", "thank you", "thanks", "thank you very much", "thank you so much", "thanks for watching",
  "thank you for watching", "bye", "bye bye", "please subscribe", "like and subscribe",
  "subtitles by the amara org community",
])

/** Whether a voice-mode transcript holds words someone said to Blitz, rather than noise. */
export function meaningful(text: string): boolean {
  const said = words(text)
  return said.length > 0 && !INVENTED.has(said.join(" "))
}

/**
 * Whether the transcript is only the kind of word a learner starts a thought with ("Okay.",
 * "Right, so", "Um"), which Smart Turn often takes for a finished turn. "Yes" and "no" are answers.
 */
export function opener(text: string): boolean {
  const said = words(text)
  return said.length > 0 && said.length <= 4 &&
    said.every(word => /^(okay|ok|right|so|um+|uh+|erm|er|and|well|alright|hmm+|mm+)$/.test(word))
}

/**
 * Turn state for one connection. A reset bumps the generation so in-flight transcripts are never emitted;
 * every new segment bumps the segment counter so a caption for audio already taken is dropped.
 */
export class VoiceTurns {
  mode: "voice" | "dictate" = "dictate"
  /** True after Silero heard speech in the current segment. */
  active = false
  private frames: Buffer[] = []
  private bytes = 0
  /** True while the final words are being transcribed; new audio is not buffered or sent to the detector. */
  transcribing = false
  private generation = 0
  private segment = 0
  private early?: Promise<string>
  private voicedAt = 0
  /** Dictated words from committed segments. */
  private committed = ""
  /** Appends committed segments in order. */
  private commits: Promise<void> = Promise.resolve()
  private pendingCommits = 0
  private captioning = false
  private ticker?: ReturnType<typeof setInterval>
  /** Voice mode: the browser was told to stop the reply for this segment's words. */
  private interrupted = false
  /** Voice mode: an opener held back to start the learner's next turn. */
  private held = ""
  private heldTimer?: ReturnType<typeof setTimeout>
  private host: VoiceTurnHost
  private captionMs: number
  private openerMs: number

  /**
   * @param host Side effects owned by the socket connection.
   * @param options Timing overrides for tests.
   */
  constructor(host: VoiceTurnHost, options: VoiceTurnOptions = {}) {
    this.host = host
    this.captionMs = options.captionMs ?? 900
    this.openerMs = options.openerMs ?? OPENER_WAIT_MS
  }

  /**
   * Adds one microphone frame. Frames that arrive while the final words are transcribed are ignored.
   * @returns False when the frame ended the connection (bad audio or an overlong turn).
   */
  audio(frame: Buffer): boolean {
    if (this.transcribing) return true
    if (frame.length % 2) { this.host.fail(new Error("Invalid microphone audio.")); return false }
    if (this.bytes + frame.length > MAX_TURN_BYTES) {
      // In conversation, two minutes without a turn boundary ends the turn rather than the session.
      if (this.mode === "voice") { void this.take(); return true }
      this.host.fail(new Error("Keep each turn under two minutes.")); return false
    }
    this.frames.push(frame); this.bytes += frame.length
    // Keep just pre-roll until Silero detects speech.
    if (!this.active && this.bytes > PRE_ROLL_BYTES) {
      this.frames = [Buffer.concat(this.frames).subarray(-PRE_ROLL_BYTES)]; this.bytes = PRE_ROLL_BYTES
    }
    if (this.mode === "dictate" && this.active && this.bytes >= FORCE_COMMIT_BYTES) this.commit()
    return true
  }

  /**
   * Marks speech starting or resuming; any speculative transcript is now out of date. Starts captions.
   * @returns False for a detector event that lagged behind a turn already being transcribed: that
   * audio is not kept, and marking it as speech would hold an empty turn open.
   */
  speech(): boolean {
    if (this.transcribing) return false
    this.active = true; this.early = undefined; this.voicedAt = Date.now()
    // The learner carried on after an opener: it starts this turn instead of being sent alone.
    clearTimeout(this.heldTimer); this.heldTimer = undefined
    if (!this.ticker) {
      this.ticker = setInterval(() => void this.caption(), this.captionMs)
      this.ticker.unref?.()
    }
    return true
  }

  /** Starts a speculative transcript at a pause in speech so a confirmed turn can finish sooner. */
  pause(): void {
    this.stopCaptions()
    if (this.active && Date.now() - this.voicedAt >= 96) {
      this.early = this.host.transcribe(Buffer.concat(this.frames), this.context())
      this.early.catch(() => undefined)
    }
  }

  /**
   * Transcribes the segment so far and sends it as a caption. Only one runs at a time, never while
   * final words are being transcribed, and a result for audio that has since been taken is dropped.
   */
  async caption(): Promise<void> {
    if (this.captioning || this.transcribing || this.pendingCommits || !this.active) return
    if (this.bytes < MIN_CAPTION_BYTES) return
    this.captioning = true
    const generation = this.generation
    const segment = this.segment
    try {
      const text = await this.host.transcribe(Buffer.concat(this.frames).subarray(-MAX_CAPTION_BYTES), this.context())
      if (generation !== this.generation || segment !== this.segment || this.host.closed()) return
      if (this.mode === "dictate") { this.host.send({ type: "caption", text: join(this.committed, text) }); return }
      // Voice mode shows and acts on words only: noise never captions, and only real words stop a reply.
      if (!meaningful(text)) return
      if (!opener(text)) this.interrupt()
      this.host.send({ type: "caption", text: join(this.held, text) })
    } catch {
      // A missed caption is harmless; the final transcription reports real failures.
    } finally {
      if (generation === this.generation) this.captioning = false
    }
  }

  /**
   * Ends the current dictation segment: its words are transcribed and appended in order while
   * listening carries on with a fresh segment.
   */
  commit(): void {
    if (this.mode !== "dictate" || !this.bytes || !this.active || this.transcribing) return
    const generation = this.generation
    const words = this.early || this.host.transcribe(Buffer.concat(this.frames), this.context())
    words.catch(() => undefined)
    this.nextSegment()
    this.pendingCommits++
    const start = Date.now()
    this.commits = this.commits.then(async () => {
      try {
        const text = await words
        if (generation !== this.generation || this.host.closed()) return
        this.committed = join(this.committed, text)
        this.host.send({ type: "caption", text: this.committed })
        this.host.log({ transcript: text, transcriptionMs: Date.now() - start, mode: this.mode, segment: true })
      } catch (error) {
        if (generation === this.generation && !this.host.closed()) this.host.fail(error)
      } finally {
        if (generation === this.generation) this.pendingCommits--
      }
    })
  }

  /**
   * Discards buffered audio, committed dictation and any transcript still in progress, as when the
   * learner mutes. A transcription that finishes after this is dropped rather than sent as their words.
   */
  reset(): void {
    this.generation++
    this.held = ""; clearTimeout(this.heldTimer); this.heldTimer = undefined
    this.nextSegment()
    this.committed = ""; this.commits = Promise.resolve(); this.pendingCommits = 0; this.captioning = false
    // New audio is accepted at once; the stale transcription can no longer finish this turn,
    // so the browser stops showing it as thinking.
    if (this.transcribing && !this.host.closed()) this.host.send({ type: "state", state: "listening" })
    this.transcribing = false
  }

  /**
   * Takes the buffered turn and sends its transcript. In dictation this is the stop: it waits for
   * committed segments, adds the rest, and always answers, with empty text when nothing was heard,
   * so the composer leaves its transcribing state instead of waiting forever.
   */
  async take(): Promise<void> {
    if (this.transcribing) return
    const dictating = this.mode === "dictate"
    if (!this.bytes && !(dictating && (this.committed || this.pendingCommits))) {
      if (dictating && !this.host.closed()) this.host.send({ type: "user", text: "" })
      return
    }
    this.transcribing = true
    const generation = this.generation
    // After committed segments, a remainder without detected speech is only silence.
    const rest = this.bytes && (!dictating || this.active || !(this.committed || this.pendingCommits))
      ? this.early || this.host.transcribe(Buffer.concat(this.frames), this.context())
      : Promise.resolve("")
    rest.catch(() => undefined)
    // A caption may already have stopped the reply for this turn; it is stopped only once.
    const interrupted = this.interrupted
    this.nextSegment()
    const start = Date.now()
    this.host.send({ type: "state", state: "thinking" })
    try {
      const last = await rest
      if (dictating) await this.commits
      if (generation !== this.generation || this.host.closed()) return
      if (dictating) {
        this.host.send({ type: "user", text: join(this.committed, last) })
        this.host.log({ transcript: last, transcriptionMs: Date.now() - start, mode: this.mode })
        this.committed = ""
      } else this.finish(last, start, interrupted)
    } catch (error) {
      if (generation === this.generation && !this.host.closed()) this.host.fail(error)
    } finally {
      if (generation === this.generation) this.transcribing = false
    }
  }

  /** Drops all audio and stops captions when the connection closes. */
  clear(): void {
    this.generation++
    this.held = ""; clearTimeout(this.heldTimer); this.heldTimer = undefined
    this.nextSegment()
    this.committed = ""; this.commits = Promise.resolve(); this.pendingCommits = 0
  }

  /**
   * Voice mode: decides what a finished turn's words are. Noise is dropped and listening carries on;
   * a lone opener waits briefly for the rest of the thought; anything else is the learner's turn.
   */
  private finish(last: string, start: number, interrupted: boolean): void {
    const real = meaningful(last)
    this.host.log({ transcript: last, transcriptionMs: Date.now() - start, mode: this.mode, ...(real ? {} : { dropped: true }) })
    if (!real || (opener(last) && !this.held)) {
      if (real) this.held = last
      this.host.send({ type: "state", state: "listening" })
      // A held opener goes out alone if nothing follows it.
      if (this.held) {
        const generation = this.generation
        clearTimeout(this.heldTimer)
        this.heldTimer = setTimeout(() => {
          this.heldTimer = undefined
          if (generation !== this.generation || this.host.closed() || this.transcribing || this.active) return
          const text = this.held; this.held = ""
          this.say(text, false)
        }, this.openerMs)
        this.heldTimer.unref?.()
      }
      return
    }
    const text = join(this.held, last)
    this.held = ""
    this.say(text, interrupted)
  }

  /** Sends the learner's turn, first stopping the reply being read unless this turn already did. */
  private say(text: string, interrupted: boolean): void {
    if (!interrupted) this.host.send({ type: "interrupt" })
    this.host.send({ type: "user", text })
  }

  /** Tells the browser, once per turn, that the learner is really talking, so it stops the reply. */
  private interrupt(): void {
    if (this.interrupted) return
    this.interrupted = true
    this.host.send({ type: "interrupt" })
  }

  /** Words already dictated, as context for the next transcription. */
  private context(): string {
    return this.mode === "dictate" ? this.committed.slice(-CONTEXT_CHARS) : ""
  }

  /** Starts a fresh segment: forgets its audio, stops captions and tells the detector the turn is over. */
  private nextSegment(): void {
    this.segment++
    this.frames = []; this.bytes = 0; this.active = false; this.early = undefined; this.interrupted = false
    this.stopCaptions()
    this.host.endTurn()
  }

  /** Stops the live caption timer. */
  private stopCaptions(): void {
    clearInterval(this.ticker); this.ticker = undefined
  }
}
