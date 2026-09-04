/**
 * Owns the bounded stdio JSON-RPC transport used to connect Blitz to the
 * locally authenticated Codex app-server. This module deliberately exposes
 * only thread and turn primitives; feature-specific orchestration belongs to
 * the callers that understand Blitz's product data.
 */

import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_LINE_BYTES = 1_000_000
const DEFAULT_MAX_PENDING_REQUESTS = 64
const DEFAULT_MAX_REQUEST_BYTES = 1_000_000

/** JSON-RPC identifiers supported by the app-server protocol. */
export type CodexRequestId = number | string

/** The small subset of a Codex thread required by this bridge. */
export interface CodexThread {
  /** Stable persisted thread identifier. */
  id: string
  /** Root session identifier, when returned by the installed server. */
  sessionId?: string
  /** Additional server fields are retained for future callers. */
  [key: string]: unknown
}

/** The small subset of a Codex turn required by this bridge. */
export interface CodexTurn {
  /** Stable turn identifier used by interruption requests. */
  id: string
  /** Server-reported lifecycle status, such as `inProgress`. */
  status?: string
  /** Additional server fields are retained for streaming consumers. */
  [key: string]: unknown
}

/** JSON-RPC error returned by app-server. */
export interface CodexRpcError {
  /** Protocol or server-specific error code. */
  code: number
  /** Human-readable error message. */
  message: string
  /** Optional structured error data. */
  data?: unknown
}

/** A notification emitted by app-server while a thread or turn is active. */
export interface CodexNotification {
  /** Notification method name, for example `item/agentMessage/delta`. */
  method: string
  /** Method parameters, whose shape varies by notification method. */
  params?: unknown
}

/** A server-initiated request, including approval prompts. */
export interface CodexServerRequest {
  /** Request identifier to echo in the client response. */
  id: CodexRequestId
  /** Server request method. */
  method: string
  /** Method parameters. */
  params?: unknown
}

/** Approval decisions accepted by command and file-change requests. */
export type CodexApprovalDecision =
  "accept" | "acceptForSession" | "decline" | "cancel"

/** Stable thread policy values verified against the installed v2 schema. */
export type CodexSandboxMode =
  "read-only" | "workspace-write" | "danger-full-access"

/** Permission response accepted by the current v2 protocol. */
export interface CodexPermissionApprovalResponse {
  /** Explicitly granted filesystem and network permissions. */
  permissions: {
    fileSystem?: unknown[] | null
    network?: { enabled?: boolean | null } | null
  }
  /** Permission lifetime; defaults to the current turn. */
  scope?: "turn" | "session"
}

/** Response payload supplied for an approval request. */
export type CodexApprovalResponse =
  { decision: CodexApprovalDecision } | CodexPermissionApprovalResponse

/** Event delivered to observers without exposing raw process internals. */
export type CodexAppServerEvent =
  | { type: "notification"; notification: CodexNotification }
  | { type: "server-request"; request: CodexServerRequest }
  | { type: "protocol-error"; error: CodexProtocolError }
  | { type: "process-error"; error: CodexAppServerError }
  | { type: "process-closed"; code: number | null; signal: string | null }

/** Function used to decide an approval after the request has been surfaced. */
export type CodexApprovalHandler = (
  request: CodexServerRequest
) => CodexApprovalResponse | Promise<CodexApprovalResponse>

/** Minimal readable side of a child process, injectable for transport tests. */
export interface CodexReadable {
  /** Subscribe to chunks or stream completion. */
  on(event: "data" | "end", listener: (...args: unknown[]) => void): this
}

/** Minimal writable side of a child process, injectable for transport tests. */
export interface CodexWritable {
  /** Write one newline-delimited JSON message. */
  write(chunk: string): boolean
  /** Close stdin when the transport is shutting down. */
  end(): void
  /** Subscribe to stdin failures such as EPIPE. */
  on(event: "error", listener: (...args: unknown[]) => void): this
}

/** Minimal child-process surface required by the JSONL transport. */
export interface CodexChildProcess {
  /** Child stdin. */
  stdin: CodexWritable
  /** Child stdout, carrying JSONL protocol messages. */
  stdout: CodexReadable
  /** Child stderr, intentionally consumed but never logged by this bridge. */
  stderr?: CodexReadable
  /** Subscribe to process failure or exit. */
  on(event: "error" | "close", listener: (...args: unknown[]) => void): this
  /** Terminate the child process. */
  kill(signal?: NodeJS.Signals): boolean
}

/** Configuration for one local app-server connection. */
export interface CodexAppServerOptions {
  /** Explicit absolute Blitz-owned workspace used as the process cwd. */
  workspaceDirectory: string
  /** Optional executable override for controlled local integration tests. */
  executable?: string
  /** Client metadata sent in the required initialize handshake. */
  clientInfo?: {
    name?: string
    title?: string
    version?: string
  }
  /** Per-request response deadline. */
  requestTimeoutMs?: number
  /** Maximum UTF-8 bytes accepted in one inbound JSONL line. */
  maxLineBytes?: number
  /** Maximum simultaneous unanswered client requests. */
  maxPendingRequests?: number
  /** Maximum UTF-8 bytes written for one outbound JSON-RPC message. */
  maxRequestBytes?: number
  /** Optional approval handler; absent handlers explicitly decline approvals. */
  approvalHandler?: CodexApprovalHandler
  /** Injectable process factory for tests; production uses `codex app-server`. */
  spawnProcess?: (workspaceDirectory: string) => CodexChildProcess
}

/** Base error for transport and app-server failures. */
export class CodexAppServerError extends Error {
  /** Optional JSON-RPC code associated with the failure. */
  readonly code?: number
  /** Optional structured JSON-RPC error data. */
  readonly data?: unknown

  /** Creates a stable, user-safe transport error without credential details. */
  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = "CodexAppServerError"
    this.code = code
    this.data = data
  }
}

/** Indicates malformed or structurally invalid JSON-RPC input. */
export class CodexProtocolError extends CodexAppServerError {
  /** Creates a protocol error with no raw line attached, avoiding data leaks. */
  constructor(message: string) {
    super(message)
    this.name = "CodexProtocolError"
  }
}

/** Indicates that a request exceeded its bounded response deadline. */
export class CodexRequestTimeoutError extends CodexAppServerError {
  /** Creates a timeout error naming only the protocol method. */
  constructor(method: string, timeoutMs: number) {
    super(`Codex app-server request timed out: ${method} (${timeoutMs}ms)`)
    this.name = "CodexRequestTimeoutError"
  }
}

interface JsonRpcResponse {
  id: CodexRequestId
  result?: unknown
  error?: CodexRpcError
}

interface JsonRpcRequest {
  id: CodexRequestId
  method: string
  params?: unknown
}

interface PendingRequest {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Parameters accepted by the bridge's intentionally narrow thread/start API. */
export interface CodexStartThreadOptions {
  /** Optional model override supported by the installed protocol. */
  model?: string
  /** Optional persisted or in-memory thread selection. */
  ephemeral?: boolean
  /** Optional approval policy; defaults to the safe on-request policy. */
  approvalPolicy?: "untrusted" | "on-request" | "never"
  /** Optional sandbox mode; defaults to the safe read-only mode. */
  sandbox?: CodexSandboxMode
}

/** Explicit policy overrides accepted when resuming a stored thread. */
export interface CodexResumeThreadOptions {
  /** Approval policy; defaults to on-request for this bridge. */
  approvalPolicy?: "untrusted" | "on-request" | "never"
  /** Sandbox mode; defaults to read-only for this bridge. */
  sandbox?: CodexSandboxMode
}

/** Parameters accepted by the bridge's narrow turn/start API. */
export interface CodexStartTurnOptions {
  /** User text sent as the supported text input item. */
  text: string
  /** Optional model override supported by the installed protocol. */
  model?: string
  /** Optional reasoning effort override supported by the installed protocol. */
  effort?: string
}

/** Typed result returned by thread/start and thread/resume. */
export interface CodexThreadResponse {
  /** Thread metadata returned by app-server. */
  thread: CodexThread
  /** Preserve additional server response fields. */
  [key: string]: unknown
}

/** Typed result returned by turn/start. */
export interface CodexTurnResponse {
  /** Initial turn metadata returned by app-server. */
  turn: CodexTurn
  /** Preserve additional server response fields. */
  [key: string]: unknown
}

/** Factory type used to start the real local Codex process. */
function defaultSpawnProcess(
  executable: string,
  workspaceDirectory: string
): CodexChildProcess {
  return spawn(executable, ["app-server", "--listen", "stdio://"], {
    cwd: workspaceDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as CodexChildProcess
}

/** Returns a validated absolute workspace path without touching credentials. */
function validateWorkspaceDirectory(workspaceDirectory: string): string {
  if (
    typeof workspaceDirectory !== "string" ||
    workspaceDirectory.length === 0 ||
    !isAbsolute(workspaceDirectory)
  ) {
    throw new CodexAppServerError(
      "Codex app-server requires an explicitly supplied absolute workspaceDirectory"
    )
  }
  return workspaceDirectory
}

/** Validates all bounded options before a child process can be created. */
function validateOptions(options: CodexAppServerOptions): void {
  validateWorkspaceDirectory(options.workspaceDirectory)
  const bounds = [
    ["requestTimeoutMs", options.requestTimeoutMs],
    ["maxLineBytes", options.maxLineBytes],
    ["maxPendingRequests", options.maxPendingRequests],
    ["maxRequestBytes", options.maxRequestBytes],
  ] as const
  for (const [name, value] of bounds) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new CodexAppServerError(
        `Codex app-server ${name} must be a positive integer`
      )
    }
  }
}

/** Ensures a decoded JSON-RPC value is a non-null record. */
function asRecord(
  value: unknown,
  description: string
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexProtocolError(`Codex ${description} must be an object`)
  }
  return value as Record<string, unknown>
}

/** Ensures an unknown protocol value is a valid JSON-RPC identifier. */
function asRequestId(value: unknown, description: string): CodexRequestId {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new CodexProtocolError(
      `Codex ${description} has an invalid request id`
    )
  }
  return value
}

/** Validates the thread or turn object needed by the public typed methods. */
function asIdentifiedObject(
  value: unknown,
  description: "thread" | "turn"
): CodexThread | CodexTurn {
  const record = asRecord(value, `${description} response`)
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new CodexProtocolError(`Codex ${description} response has no id`)
  }
  return record as CodexThread | CodexTurn
}

/** Emits approval-safe decline payloads matching the installed v2 protocol. */
function defaultApprovalResponse(method: string): CodexApprovalResponse {
  if (method === "item/permissions/requestApproval") {
    return { permissions: { fileSystem: null, network: null }, scope: "turn" }
  }
  return { decision: "decline" }
}

/** Local JSONL client with bounded memory, correlation, and process cleanup. */
export class CodexAppServerClient {
  private readonly child: CodexChildProcess
  private readonly workspaceDirectory: string
  private readonly requestTimeoutMs: number
  private readonly maxLineBytes: number
  private readonly maxPendingRequests: number
  private readonly maxRequestBytes: number
  private readonly approvalHandler?: CodexApprovalHandler
  private readonly decoder = new StringDecoder("utf8")
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>()
  private readonly pending = new Map<CodexRequestId, PendingRequest>()
  private nextRequestId = 1
  private inputBuffer = ""
  private initialized = false
  private closed = false
  private processClosed = false
  private terminationRequested = false
  private forceKillTimer?: ReturnType<typeof setTimeout>

  /** Starts a process and completes the required initialize handshake. */
  static async connect(
    options: CodexAppServerOptions
  ): Promise<CodexAppServerClient> {
    validateOptions(options)
    const workspaceDirectory = validateWorkspaceDirectory(
      options.workspaceDirectory
    )
    const executable = options.executable ?? "codex"
    const child = options.spawnProcess
      ? options.spawnProcess(workspaceDirectory)
      : defaultSpawnProcess(executable, workspaceDirectory)
    const client = new CodexAppServerClient(child, options)
    try {
      await client.initialize(options.clientInfo)
      return client
    } catch (error) {
      await client.close()
      throw error
    }
  }

  /** Attaches bounded stream readers and process lifecycle handlers. */
  private constructor(
    child: CodexChildProcess,
    options: CodexAppServerOptions
  ) {
    this.child = child
    this.workspaceDirectory = validateWorkspaceDirectory(
      options.workspaceDirectory
    )
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.maxPendingRequests =
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this.approvalHandler = options.approvalHandler

    if (
      !Number.isInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      !Number.isInteger(this.maxLineBytes) ||
      this.maxLineBytes <= 0 ||
      !Number.isInteger(this.maxPendingRequests) ||
      this.maxPendingRequests <= 0 ||
      !Number.isInteger(this.maxRequestBytes) ||
      this.maxRequestBytes <= 0
    ) {
      throw new CodexAppServerError(
        "Codex app-server bounds must be positive integers"
      )
    }

    child.stdout.on("data", (chunk: unknown) => this.handleStdoutChunk(chunk))
    child.stdout.on("end", () => this.handleStdoutEnd())
    child.stderr?.on("data", () => {
      // Consume stderr so a noisy child cannot block. Never expose its contents.
    })
    child.stdin.on("error", (error: unknown) => this.handleProcessError(error))
    child.on("error", (error: unknown) => this.handleProcessError(error))
    child.on("close", (...args: unknown[]) => {
      const code = typeof args[0] === "number" ? args[0] : null
      const signal = typeof args[1] === "string" ? args[1] : null
      this.handleProcessClose(code, signal)
    })
  }

  /** Subscribes to streaming notifications and approval requests. */
  onEvent(listener: (event: CodexAppServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Sends initialize, waits for its response, then acknowledges initialized. */
  private async initialize(
    clientInfo?: CodexAppServerOptions["clientInfo"]
  ): Promise<void> {
    const result = await this.request("initialize", {
      clientInfo: {
        name: clientInfo?.name ?? "blitz",
        title: clientInfo?.title ?? "Blitz",
        version: clientInfo?.version ?? "0.0.1",
      },
    })
    asRecord(result, "initialize response")
    this.writeMessage({ method: "initialized", params: {} })
    this.initialized = true
  }

  /** Starts a persisted or ephemeral thread in the explicit Blitz workspace. */
  async startThread(
    options: CodexStartThreadOptions = {}
  ): Promise<CodexThreadResponse> {
    const {
      approvalPolicy = "on-request",
      sandbox = "read-only",
      ...rest
    } = options
    const result = await this.request("thread/start", {
      cwd: this.workspaceDirectory,
      approvalPolicy,
      sandbox,
      ...rest,
    })
    return this.parseThreadResponse(result)
  }

  /** Resumes a stored thread by its server-issued identifier. */
  async resumeThread(
    threadId: string,
    options: CodexResumeThreadOptions = {}
  ): Promise<CodexThreadResponse> {
    if (!threadId) throw new CodexAppServerError("threadId is required")
    const { approvalPolicy = "on-request", sandbox = "read-only" } = options
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.workspaceDirectory,
      approvalPolicy,
      sandbox,
    })
    return this.parseThreadResponse(result)
  }

  /** Starts a text turn and returns its initial server-issued turn metadata. */
  async startTurn(
    threadId: string,
    options: CodexStartTurnOptions
  ): Promise<CodexTurnResponse> {
    if (!threadId) throw new CodexAppServerError("threadId is required")
    if (!options.text) throw new CodexAppServerError("turn text is required")
    const result = await this.request("turn/start", {
      threadId,
      cwd: this.workspaceDirectory,
      input: [{ type: "text", text: options.text }],
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort }),
    })
    const record = asRecord(result, "turn/start response")
    return {
      ...record,
      turn: asIdentifiedObject(record.turn, "turn") as CodexTurn,
    }
  }

  /** Requests interruption of an active turn and returns the empty response. */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (!threadId) throw new CodexAppServerError("threadId is required")
    if (!turnId) throw new CodexAppServerError("turnId is required")
    await this.request("turn/interrupt", { threadId, turnId })
  }

  /** Stops the child process, clears pending requests, and releases listeners. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.rejectPending(
      new CodexAppServerError("Codex app-server connection closed")
    )
    try {
      this.child.stdin.end()
    } catch {
      // The process may already have exited; kill below remains best effort.
    }
    this.terminateProcess()
    this.listeners.clear()
  }

  /** Parses one arbitrary stdout chunk while enforcing a bounded line buffer. */
  private handleStdoutChunk(chunk: unknown): void {
    if (this.closed) return
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array)
    const text = this.decoder.write(bytes)
    this.inputBuffer += text
    if (
      Buffer.byteLength(this.inputBuffer) > this.maxLineBytes &&
      !this.inputBuffer.includes("\n")
    ) {
      this.failProtocol(
        "Codex app-server JSONL line exceeded the configured limit"
      )
      return
    }
    let newlineIndex = this.inputBuffer.indexOf("\n")
    while (newlineIndex >= 0) {
      const line = this.inputBuffer.slice(0, newlineIndex).replace(/\r$/, "")
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.failProtocol(
          "Codex app-server JSONL line exceeded the configured limit"
        )
        return
      }
      if (line.trim().length > 0) this.handleLine(line)
      newlineIndex = this.inputBuffer.indexOf("\n")
    }
    if (Buffer.byteLength(this.inputBuffer) > this.maxLineBytes) {
      this.failProtocol(
        "Codex app-server JSONL line exceeded the configured limit"
      )
    }
  }

  /** Rejects an unterminated final line instead of silently dropping it. */
  private handleStdoutEnd(): void {
    if (this.closed) return
    this.inputBuffer += this.decoder.end()
    if (this.inputBuffer.trim().length === 0) return
    this.failProtocol("Codex app-server ended with an incomplete JSONL message")
  }

  /** Decodes and dispatches exactly one JSON-RPC message. */
  private handleLine(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      this.failProtocol("Codex app-server emitted malformed JSON")
      return
    }
    try {
      const message = asRecord(decoded, "JSON-RPC message")
      if (typeof message.method === "string") {
        if (message.id === undefined) {
          this.emit({
            type: "notification",
            notification: { method: message.method, params: message.params },
          })
          return
        }
        const request: JsonRpcRequest = {
          id: asRequestId(message.id, "server request"),
          method: message.method,
          params: message.params,
        }
        void this.handleServerRequest(request).catch(() => {
          this.fail(
            new CodexAppServerError("Codex server request handling failed")
          )
        })
        return
      }
      if (message.id === undefined)
        throw new CodexProtocolError("JSON-RPC response has no id")
      const response: JsonRpcResponse = {
        id: asRequestId(message.id, "response"),
        result: message.result,
        error: message.error as CodexRpcError | undefined,
      }
      this.handleResponse(response)
    } catch (error) {
      this.failProtocol(
        error instanceof CodexProtocolError
          ? error.message
          : "Codex app-server message was invalid"
      )
    }
  }

  /** Resolves one correlated request or rejects it with the server error. */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (response.error) {
      pending.reject(
        new CodexAppServerError(
          response.error.message || `Codex request failed: ${pending.method}`,
          response.error.code,
          response.error.data
        )
      )
      return
    }
    pending.resolve(response.result)
  }

  /** Surfaces every server request and handles approvals without silent grants. */
  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const publicRequest: CodexServerRequest = request
    this.emit({ type: "server-request", request: publicRequest })
    if (request.method.endsWith("requestApproval")) {
      let response = defaultApprovalResponse(request.method)
      if (this.approvalHandler) {
        try {
          response = await this.approvalHandler(publicRequest)
        } catch {
          response = defaultApprovalResponse(request.method)
        }
      }
      if (!this.closed) {
        try {
          this.writeMessage({ id: request.id, result: response })
        } catch (error) {
          this.fail(
            error instanceof Error
              ? error
              : new CodexAppServerError(
                  "Codex approval response could not be written"
                )
          )
        }
      }
      return
    }
    if (!this.closed) {
      try {
        this.writeMessage({
          id: request.id,
          error: {
            code: -32601,
            message: "Blitz has not wired this Codex server request",
          },
        })
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new CodexAppServerError(
                "Codex server request response could not be written"
              )
        )
      }
    }
  }

  /** Sends one bounded request and returns its eventual correlated result. */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new CodexAppServerError("Codex app-server connection is closed")
      )
    if (method !== "initialize" && !this.initialized) {
      return Promise.reject(
        new CodexAppServerError("Codex app-server is not initialized")
      )
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(
        new CodexAppServerError("Too many pending Codex app-server requests")
      )
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        const error = new CodexRequestTimeoutError(
          method,
          this.requestTimeoutMs
        )
        reject(error)
        this.fail(error)
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.writeMessage({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(
          error instanceof Error
            ? error
            : new CodexAppServerError("Codex request could not be written")
        )
      }
    })
  }

  /** Serializes and writes one JSON-RPC message under the outbound byte bound. */
  private writeMessage(message: Record<string, unknown>): void {
    const serialized = `${JSON.stringify(message)}\n`
    if (Buffer.byteLength(serialized) > this.maxRequestBytes) {
      throw new CodexAppServerError(
        "Codex app-server request exceeded the configured size limit"
      )
    }
    try {
      this.child.stdin.write(serialized)
    } catch {
      throw new CodexAppServerError("Codex app-server stdin is unavailable")
    }
  }

  /** Validates the common shape returned by thread/start and thread/resume. */
  private parseThreadResponse(result: unknown): CodexThreadResponse {
    const record = asRecord(result, "thread response")
    return {
      ...record,
      thread: asIdentifiedObject(record.thread, "thread") as CodexThread,
    }
  }

  /** Delivers an event to current observers while isolating observer failures. */
  private emit(event: CodexAppServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A consumer cannot be allowed to break protocol correlation.
      }
    }
  }

  /** Fails the connection on malformed protocol input and performs cleanup. */
  private failProtocol(message: string): void {
    const error = new CodexProtocolError(message)
    this.emit({ type: "protocol-error", error })
    this.fail(error)
  }

  /** Rejects all pending calls and terminates a failed process exactly once. */
  private fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.rejectPending(error)
    this.terminateProcess()
    this.emit({ type: "process-error", error: error as CodexAppServerError })
    this.listeners.clear()
  }

  /** Requests graceful termination and bounds escalation to SIGKILL. */
  private terminateProcess(): void {
    if (this.terminationRequested || this.processClosed) return
    this.terminationRequested = true
    try {
      this.child.kill("SIGTERM")
    } catch {
      // Process failure cleanup is best effort and must remain idempotent.
    }
    this.forceKillTimer = setTimeout(() => {
      if (this.processClosed) return
      try {
        this.child.kill("SIGKILL")
      } catch {
        // The child may have exited between the two signals.
      }
    }, 2_000)
    this.forceKillTimer.unref?.()
  }

  /** Rejects and clears all unanswered request promises. */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  /** Converts child process errors to a safe transport error. */
  private handleProcessError(error: unknown): void {
    const message =
      error instanceof Error ? error.message : "Codex app-server process failed"
    this.fail(
      new CodexAppServerError(`Codex app-server process failed: ${message}`)
    )
  }

  /** Cleans pending calls when the child exits and reports its exit status. */
  private handleProcessClose(code: number | null, signal: string | null): void {
    this.processClosed = true
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer)
    if (!this.closed) {
      this.closed = true
      this.rejectPending(
        new CodexAppServerError("Codex app-server process exited")
      )
      this.emit({
        type: "process-error",
        error: new CodexAppServerError("Codex app-server process exited"),
      })
    }
    this.emit({ type: "process-closed", code, signal })
    this.listeners.clear()
  }
}
