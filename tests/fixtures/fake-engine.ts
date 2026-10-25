/**
 * In-memory agent-engines `Engine` for provider tests. It records the thread
 * and turn options Blitz sends and lets a test script each turn's events. No
 * runtime process, model turn, or network connection is used.
 *
 * Only the methods Blitz calls are modelled: start, resume, fork, prewarm,
 * compact, rewind, and context usage. The rest of the engine and thread
 * surface (history, goals, MCP controls, sign-in and so on) throws
 * `UnsupportedFeatureError`, as a runtime without that feature would,
 * so a test fails loudly if Blitz starts relying on one without a fake for it.
 */

import {
  UnsupportedFeatureError,
  type AgentEvent,
  type ContextUsage,
  type Engine,
  type ForkOptions,
  type Thread,
  type ThreadOptions,
  type Turn,
  type TurnInput,
  type TurnOptions,
  type TurnResult,
} from "agent-engines"

/**
 * Returns a method that throws `UnsupportedFeatureError` for one feature the
 * fake does not model.
 *
 * @param feature - What the method does, as the error message names it.
 * @param provider - Provider reported in the error.
 */
function refuse(
  feature: string,
  provider: string
): (...args: unknown[]) => never {
  return () => {
    throw new UnsupportedFeatureError(feature, provider, "not in the test fake")
  }
}

/** Thread methods Blitz does not call, each refusing as unsupported. */
type RefusedThreadMethods = Omit<
  Thread,
  | "id"
  | "provider"
  | "run"
  | "compact"
  | "activeTurn"
  | "subscribe"
  | "subagentTranscript"
  | "lastTurn"
  | "interruptTurn"
  | "mcpStatus"
  | "rewind"
  | "contextUsage"
  | "close"
>

/**
 * Builds the refused part of a fake thread.
 *
 * @param provider - Provider reported in each error.
 */
function refusedThreadMethods(provider: string): RefusedThreadMethods {
  const no = (feature: string) => refuse(feature, provider)
  return {
    history: no("read thread history"),
    rename: no("rename a thread"),
    setGoal: no("set a goal"),
    goal: no("read a goal"),
    clearGoal: no("clear a goal"),
    review: no("run a review"),
    shell: no("run a shell command"),
    tasks: no("list tasks"),
    stopTask: no("stop a task"),
    setMcpServers: no("replace MCP servers"),
    reconnectMcp: no("reconnect an MCP server"),
    toggleMcp: no("toggle an MCP server"),
    mcpLogin: no("sign in to an MCP server"),
    readMcpResource: no("read an MCP resource"),
    reloadSkills: no("reload skills"),
    reloadPlugins: no("reload plugins"),
    export: no("export a thread"),
    realtime: no("open a realtime session"),
  }
}

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
  /** Source thread and options of each forked thread. */
  readonly forks: Array<{ id: string; options: ForkOptions }> = []
  /** Error thrown by `forkThread`, when set. */
  forkError?: unknown
  /** Thread options passed to each `prewarm` call. */
  readonly prewarms: Array<ThreadOptions | undefined> = []
  /** Thread ID of each `compact` call. */
  readonly compactions: string[] = []
  /** How each compaction turn ends; `completed` with a `compacted` event by default. */
  compactScript: (turn: FakeTurn) => void = (turn) => {
    turn.push({ type: "turn.started" })
    turn.push({ type: "compacted", beforeTokens: 900, afterTokens: 100 })
    turn.finish({ status: "completed" })
  }
  /** Turn ID passed to each `rewind` call. */
  readonly rewinds: string[] = []
  /** Error thrown by `rewind`, when set. */
  rewindError?: unknown
  /** Context usage reported by every thread; unset refuses, as a runtime without it would. */
  contextReport?: ContextUsage

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

  /** Not modelled; Blitz does not read capabilities. */
  capabilities(): never {
    return this.refuse("report capabilities")
  }

  async forkThread(id: string, options: ForkOptions): Promise<Thread> {
    if (this.forkError) throw this.forkError
    this.forks.push({ id, options })
    return this.thread("thr_fork")
  }

  /** Not modelled; Blitz does not list saved threads. */
  listThreads(): never {
    return this.refuse("list threads")
  }

  /** Not modelled; Blitz does not read saved threads back. */
  readThread(): never {
    return this.refuse("read a thread")
  }

  /** Not modelled; Blitz names chats itself. */
  renameThread(): never {
    return this.refuse("rename a thread")
  }

  /** Not modelled; Blitz does not archive runtime threads. */
  archiveThread(): never {
    return this.refuse("archive a thread")
  }

  /** Not modelled; Blitz does not archive runtime threads. */
  unarchiveThread(): never {
    return this.refuse("unarchive a thread")
  }

  /** Not modelled; sign-in runs through the CLIs' own login commands. */
  login(): never {
    return this.refuse("sign in")
  }

  /** Not modelled; sign-out runs through the CLIs' own logout commands. */
  logout(): never {
    return this.refuse("sign out")
  }

  async prewarm(options?: ThreadOptions): Promise<void> {
    this.prewarms.push(options)
  }

  /** Not modelled; Blitz does not search runtime files. */
  searchFiles(): never {
    return this.refuse("search files")
  }

  /** Not modelled; Blitz does not read runtime config. */
  config(): never {
    return this.refuse("read config")
  }

  /** Not modelled; Blitz does not manage plugins. */
  plugins(): never {
    return this.refuse("list plugins")
  }

  /** Not modelled; Blitz does not manage plugins. */
  installPlugin(): never {
    return this.refuse("install a plugin")
  }

  /** Not modelled; Blitz does not manage plugins. */
  uninstallPlugin(): never {
    return this.refuse("uninstall a plugin")
  }

  /** Not modelled; Blitz does not manage skills. */
  setSkillEnabled(): never {
    return this.refuse("toggle a skill")
  }

  /** Engine-wide events are not used; nothing is ever delivered. */
  subscribe(): () => void {
    return () => undefined
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

  /** Throws the error a runtime without `feature` would. */
  private refuse(feature: string): never {
    return refuse(feature, this.provider)()
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
      compact: (): Turn => {
        this.compactions.push(id)
        const turn = new FakeTurn(id, `compact_${this.compactions.length}`)
        setTimeout(() => this.compactScript(turn), 0)
        return turn
      },
      rewind: async (turnId: string) => {
        if (this.rewindError) throw this.rewindError
        this.rewinds.push(turnId)
        return { droppedTurns: 1 }
      },
      contextUsage: async () => {
        if (!this.contextReport) return this.refuse("report context usage")
        return this.contextReport
      },
      activeTurn: undefined,
      subscribe: () => () => undefined,
      subagentTranscript: async () => [],
      lastTurn: async () => undefined,
      interruptTurn: async () => undefined,
      mcpStatus: async () => [],
      ...refusedThreadMethods(this.provider),
      close: async () => {
        this.threadCloses += 1
      },
    }
  }
}
