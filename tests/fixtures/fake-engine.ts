/**
 * In-memory agent-engines `Engine` for provider tests. It records the thread
 * and turn options Blitz sends and lets a test script each turn's events. No
 * runtime process, model turn, or network connection is used.
 */

import type {
  AgentEvent,
  Engine,
  Thread,
  ThreadOptions,
  Turn,
  TurnInput,
  TurnOptions,
  TurnResult,
} from "agent-engines"

/** A scripted turn: push events, then finish it. */
export class FakeTurn implements Turn {
  readonly id: Promise<string>
  readonly result: Promise<TurnResult>
  /** Number of `interrupt` calls received. */
  interrupts = 0
  private readonly queue: AgentEvent[] = []
  private waiting?: () => void
  private done = false
  private resolveResult!: (result: TurnResult) => void

  readonly threadId: string
  readonly turnId: string

  constructor(threadId: string, turnId: string) {
    this.threadId = threadId
    this.turnId = turnId
    this.id = Promise.resolve(turnId)
    this.result = new Promise((resolve) => (this.resolveResult = resolve))
  }

  /** Queues one event for the consumer, filling in the thread and turn IDs. */
  push(event: Record<string, unknown>): void {
    if (this.done) return
    this.queue.push({
      threadId: this.threadId,
      turnId: this.turnId,
      ...event,
    } as AgentEvent)
    this.wake()
  }

  /** Settles the turn as the engine would. */
  finish(result: Partial<TurnResult> & Pick<TurnResult, "status">): void {
    if (this.done) return
    this.done = true
    this.resolveResult({
      threadId: this.threadId,
      turnId: this.turnId,
      text: "",
      ...result,
    })
    this.wake()
  }

  /** Completes the turn with one answer message. */
  answer(text: string): void {
    this.push({ type: "turn.started" })
    this.push({ type: "text.delta", itemId: "m1", delta: text })
    this.push({ type: "text.done", itemId: "m1", text })
    this.finish({ status: "completed", text })
  }

  /** Steering is not exercised by these tests. */
  async steer(): Promise<void> {}

  async interrupt(): Promise<void> {
    this.interrupts += 1
    this.finish({ status: "interrupted" })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    for (;;) {
      const event = this.queue.shift()
      if (event) {
        yield event
        continue
      }
      if (this.done) return
      await new Promise<void>((resolve) => (this.waiting = resolve))
    }
  }

  private wake(): void {
    const waiting = this.waiting
    this.waiting = undefined
    waiting?.()
  }
}

/** An engine whose threads run the given script for each turn. */
export class FakeEngine implements Engine {
  readonly provider: "codex" | "claude"
  /** Options of each started thread. */
  readonly started: ThreadOptions[] = []
  /** Thread ID and options of each resumed thread. */
  readonly resumed: Array<{ id: string; options: ThreadOptions }> = []
  /** Input and options of each turn run. */
  readonly runs: Array<{ input: TurnInput; options?: TurnOptions }> = []
  /** Turns started so far. */
  readonly turns: FakeTurn[] = []
  /** Whether `close` was called. */
  closed = false
  /** Number of thread `close` calls. */
  threadCloses = 0
  /** Error thrown by `startThread` and `resumeThread`, when set. */
  startError?: unknown

  private readonly script: (turn: FakeTurn) => void

  constructor(
    provider: "codex" | "claude",
    script: (turn: FakeTurn) => void = (turn) => turn.answer("A clear answer.")
  ) {
    this.provider = provider
    this.script = script
  }

  async availability(): Promise<never> {
    throw new Error("not used")
  }

  async models(): Promise<never[]> {
    return []
  }

  async usage(): Promise<never> {
    throw new Error("not used")
  }

  async commands(): Promise<never[]> {
    return []
  }

  async startThread(options: ThreadOptions): Promise<Thread> {
    if (this.startError) throw this.startError
    this.started.push(options)
    return this.thread("thr_new")
  }

  async resumeThread(id: string, options: ThreadOptions): Promise<Thread> {
    if (this.startError) throw this.startError
    this.resumed.push({ id, options })
    return this.thread(id)
  }

  async deleteThread(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true
  }

  /** A thread that hands each run to the script. */
  private thread(id: string): Thread {
    return {
      id,
      provider: this.provider,
      run: (input: TurnInput, options?: TurnOptions): Turn => {
        this.runs.push({ input, ...(options ? { options } : {}) })
        const turn = new FakeTurn(id, `turn_${this.turns.length + 1}`)
        this.turns.push(turn)
        setTimeout(() => this.script(turn), 0)
        return turn
      },
      compact: () => {
        throw new Error("not used")
      },
      activeTurn: undefined,
      subscribe: () => () => undefined,
      subagentTranscript: async () => [],
      lastTurn: async () => undefined,
      interruptTurn: async () => undefined,
      mcpStatus: async () => [],
      close: async () => {
        this.threadCloses += 1
      },
    }
  }
}
