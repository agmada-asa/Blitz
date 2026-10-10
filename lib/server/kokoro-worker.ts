/** Owns the speech subprocess, bounded inference, idle shutdown, and recovery after failure. */

import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

/** Describes a local speech runtime failure suitable for an API response. */
export class KokoroUnavailableError extends Error {
  /** Creates a recoverable speech error with a useful message. */
  constructor(message: string) {
    super(message)
    this.name = "KokoroUnavailableError"
  }
}

/** One validated request sent to the Python worker over its private stdin pipe. */
export type KokoroRequest = {
  text: string
  voiceId: string
  outputPath: string
}

/** A protocol operation waiting for readiness or one synthesis reply. */
type Operation = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

/** One process generation; replies and timers must never affect its replacement. */
type Session = {
  child: ChildProcessWithoutNullStreams
  ready: Operation
  reply?: Operation
  initialized: boolean
  finished: boolean
  stderr: string
  startupTimer?: NodeJS.Timeout
  requestTimer?: NodeJS.Timeout
  idleTimer?: NodeJS.Timeout
  exited: Promise<void>
  resolveExited: () => void
  termination?: Promise<void>
}

/** Creates a promise whose settlement is controlled by the worker protocol. */
function operation(): Operation {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Shares one model process and waits for failed processes to exit before starting replacements. */
export class KokoroWorker {
  private session?: Session
  private stopping?: Promise<void>
  private sessions = new Set<Session>()
  private spawnWorker: () => ChildProcessWithoutNullStreams
  private startupTimeoutMs: number
  private requestTimeoutMs: number
  private idleTimeoutMs: number
  private shutdownGraceMs: number

  /** Accepts a process factory and bounded deadlines, overridable for lifecycle tests. */
  constructor(options: {
    spawnWorker: () => ChildProcessWithoutNullStreams
    startupTimeoutMs?: number
    requestTimeoutMs?: number
    idleTimeoutMs?: number
    shutdownGraceMs?: number
  }) {
    this.spawnWorker = options.spawnWorker
    this.startupTimeoutMs = options.startupTimeoutMs ?? 180_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000
    this.shutdownGraceMs = options.shutdownGraceMs ?? 1_000
  }

  /** Starts or joins model startup; failed startup always finishes cleanup before returning. */
  async start(): Promise<void> {
    await this.stopping
    const session = this.session ?? this.launch()
    try {
      await session.ready.promise
    } catch (error) {
      await this.stopSession(session)
      throw error
    }
  }

  /** Runs one request with a wall-clock deadline; callers serialize requests through SpeechQueue. */
  async synthesize(request: KokoroRequest): Promise<void> {
    await this.start()
    const session = this.session
    if (!session || session.finished) {
      throw new KokoroUnavailableError(
        "The local speech worker stopped. Try again."
      )
    }
    if (session.reply) throw new Error("Speech inference is already running.")
    clearTimeout(session.idleTimer)
    const reply = operation()
    session.reply = reply
    session.requestTimer = setTimeout(() => {
      reply.reject(
        new KokoroUnavailableError(
          "Speech generation took too long. Try a shorter section."
        )
      )
    }, this.requestTimeoutMs)
    try {
      try {
        session.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error)
            reply.reject(
              new KokoroUnavailableError(
                "The local speech worker stopped accepting requests."
              )
            )
        })
      } catch (error) {
        reply.reject(
          error instanceof Error
            ? error
            : new Error("Could not send speech request.")
        )
      }
      await reply.promise
    } catch (error) {
      await this.stopSession(session)
      throw error
    } finally {
      clearTimeout(session.requestTimer)
      session.reply = undefined
      if (this.session === session && !session.finished)
        this.scheduleIdleStop(session)
    }
  }

  /** Immediately kills owned processes on Node exit, when asynchronous cleanup cannot run. */
  killNow(): void {
    for (const session of this.sessions) session.child.kill("SIGKILL")
  }

  /** Creates a process generation and attaches protocol and exit handlers before it can respond. */
  private launch(): Session {
    const child = this.spawnWorker()
    let resolveExited!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve
    })
    const session: Session = {
      child,
      ready: operation(),
      initialized: false,
      finished: false,
      stderr: "",
      exited,
      resolveExited,
    }
    this.session = session
    this.sessions.add(session)
    const lines = createInterface({ input: child.stdout })
    child.stdin.on("error", () => {
      const failure = new KokoroUnavailableError(
        "The local speech worker stopped accepting requests."
      )
      session.ready.reject(failure)
      session.reply?.reject(failure)
      void this.stopSession(session)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      session.stderr = `${session.stderr}${chunk.toString()}`.slice(-4_000)
    })
    lines.on("line", (line) => {
      if (this.session !== session || session.finished || session.termination)
        return
      let message: { ready?: boolean; ok?: boolean; error?: string }
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== "object") return
        message = value as typeof message
      } catch {
        return
      }
      if (!session.initialized) {
        if (typeof message.ready !== "boolean") return
        clearTimeout(session.startupTimer)
        if (message.ready) {
          session.initialized = true
          this.scheduleIdleStop(session)
          session.ready.resolve()
        } else {
          session.ready.reject(
            new KokoroUnavailableError(
              `Local speech could not start. ${message.error ?? "Check the local setup and try again."}`
            )
          )
        }
      } else if (typeof message.ok === "boolean") {
        if (message.ok) session.reply?.resolve()
        else
          session.reply?.reject(
            new Error(message.error || "Could not create speech audio.")
          )
      }
    })
    child.once("error", (error: NodeJS.ErrnoException) => {
      const failure = new KokoroUnavailableError(
        error.code === "ENOENT"
          ? "Kokoro is not installed. Run scripts/setup-kokoro.sh, then restart Blitz."
          : `Local speech could not start: ${error.message}`
      )
      session.ready.reject(failure)
      session.reply?.reject(failure)
      // A failed spawn has no process and never emits an exit event.
      if (!child.pid) {
        this.finish(session, failure)
        lines.close()
      } else void this.stopSession(session)
    })
    child.once("exit", (code, signal) => {
      this.finish(
        session,
        new KokoroUnavailableError(
          `The local speech worker stopped (${signal ?? code ?? "unknown"}).${session.stderr ? ` ${session.stderr.trim()}` : ""}`
        )
      )
      lines.close()
    })
    session.startupTimer = setTimeout(() => {
      session.ready.reject(
        new KokoroUnavailableError(
          "Kokoro is taking too long to start. Check the local setup and try again."
        )
      )
    }, this.startupTimeoutMs)
    return session
  }

  /** Settles outstanding operations and releases timers when this process exits. */
  private finish(session: Session, failure: Error): void {
    session.finished = true
    clearTimeout(session.startupTimer)
    clearTimeout(session.requestTimer)
    clearTimeout(session.idleTimer)
    session.ready.reject(failure)
    session.reply?.reject(failure)
    session.resolveExited()
    this.sessions.delete(session)
    if (this.session === session) this.session = undefined
  }

  /** Releases an unused model without interrupting startup or an active inference. */
  private scheduleIdleStop(session: Session): void {
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (this.session === session && !session.reply)
        void this.stopSession(session)
    }, this.idleTimeoutMs)
    session.idleTimer.unref()
  }

  /** Terminates a retired worker, escalates even after SIGTERM was sent, and waits for actual exit. */
  private stopSession(session: Session): Promise<void> {
    if (session.termination) return session.termination
    clearTimeout(session.startupTimer)
    clearTimeout(session.requestTimer)
    clearTimeout(session.idleTimer)
    if (this.session === session) this.session = undefined
    if (session.finished) return session.exited
    const forceTimer = setTimeout(
      () => session.child.kill("SIGKILL"),
      this.shutdownGraceMs
    )
    session.termination = session.exited.finally(() => clearTimeout(forceTimer))
    this.stopping = session.termination
    session.child.kill("SIGTERM")
    return session.termination
  }
}
