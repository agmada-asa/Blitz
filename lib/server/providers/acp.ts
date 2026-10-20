/** Runs bounded Agent Client Protocol turns for OpenCode. */

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

import { openCodeEnvironment } from "./opencode-policy.ts"

import type {
  ProviderAuthMethod,
  ProviderApprovalHandler,
  ProviderCommand,
  ProviderEvent,
  ProviderModelOption,
  ProviderSelection,
  ProviderTextTurnRequest,
  ProviderTextTurnResult,
} from "./types.ts"

const MAX_OUTPUT_BYTES = 250_000
const MAX_STREAM_BYTES = 4_000_000
const MAX_PROMPT_BYTES = 30_000_000

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_LINE_BYTES = 1_000_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Child-process surface required by the small ACP client. */
export interface AcpChildProcess {
  /** Child stdin used for JSON-RPC requests. */
  readonly stdin: {
    write(chunk: string): boolean
    end(): void
    on(event: "error", listener: (...args: unknown[]) => void): void
  }
  /** Child stdout carrying newline-delimited JSON-RPC messages. */
  readonly stdout: {
    on(event: "data" | "end", listener: (...args: unknown[]) => void): void
  }
  /** Child stderr consumed without exposing provider diagnostics. */
  readonly stderr?: {
    on(event: "data", listener: (...args: unknown[]) => void): void
  }
  /** Child lifecycle events. */
  on(event: "error" | "close", listener: (...args: unknown[]) => void): void
  /** Stops the provider process. */
  kill(signal?: NodeJS.Signals): boolean
}

/** Safe ACP runtime failure that omits prompts, credentials, and raw output. */
export class AcpProviderError extends Error {
  /** Optional machine-readable failure category. */
  readonly code:
    "invalid-input" | "timeout" | "aborted" | "transport" | "protocol"

  /** Creates one bounded ACP error. */
  constructor(
    code: AcpProviderError["code"],
    message: string,
    cause?: unknown
  ) {
    super(message)
    this.name = "AcpProviderError"
    this.code = code
    this.cause = cause
  }

  /** Underlying detail retained for server diagnostics without serialization. */
  readonly cause?: unknown
}

type JsonRpcId = number | string

type PendingRequest = {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Handles a verified ACP reverse request and returns its native JSON result. */
export type AcpRequestHandler = (request: {
  readonly requestId: JsonRpcId
  readonly method: string
  readonly params: unknown
  /** Provider session extracted from the request when the protocol supplies it. */
  readonly sessionId?: string
  /** Aborts when the provider turn is cancelled or the request times out. */
  readonly signal?: AbortSignal
}) => Promise<unknown>

/** Converts an unknown value into an object without trusting its fields. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

/** Returns a string field from an unknown protocol record. */
function stringField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key]
  return typeof field === "string" && field.trim() ? field : undefined
}

/** Maps a provider model label or ID to Blitz's reasoning vocabulary when it is explicit. */
function parseReasoningEffort(
  id: string,
  label: string
): ProviderModelOption["reasoningEffort"] {
  const match = `${label} ${id}`.match(
    /(?:^|[\s(_-])(extra[\s_-]?high|xhigh|ultra|max(?:imum)?|high|medium|low)(?:[\s)_-]|$)/i
  )
  const value = match?.[1]?.toLowerCase().replace(/[\s_-]/g, "")
  if (value === "extrahigh" || value === "xhigh") return "xhigh"
  if (value === "maximum" || value === "max") return "max"
  if (value === "ultra") return "ultra"
  if (value === "high" || value === "medium" || value === "low") return value
  return undefined
}

/** Extracts the authenticated provider's model selector from an ACP session response. */
export function parseAcpModelOptions(
  value: unknown
): readonly ProviderModelOption[] {
  const setup = record(value)
  const configOptions = Array.isArray(setup?.configOptions)
    ? setup.configOptions
    : []
  const config = configOptions
    .map(record)
    .find(
      (option) =>
        option?.type === "select" &&
        (option.id === "model" || option.category === "model")
    )
  const rawOptions = Array.isArray(config?.options) ? config.options : []
  const models = record(setup?.models)
  const rawModels = Array.isArray(models?.availableModels)
    ? models.availableModels
    : []
  const source = rawOptions.length > 0 ? rawOptions : rawModels
  const entries = rawOptions.flatMap((entry): Record<string, unknown>[] => {
    const option = record(entry)
    if (!option) return []
    if (typeof option.value === "string") return [option]
    return Array.isArray(option.options)
      ? (option.options.map(record).filter(Boolean) as Record<
          string,
          unknown
        >[])
      : []
  })
  if (rawOptions.length === 0) {
    entries.push(
      ...source.flatMap((entry): Record<string, unknown>[] => {
        const option = record(entry)
        if (!option) return []
        const id =
          stringField(option, "id") ??
          stringField(option, "modelId") ??
          stringField(option, "value")
        return id ? [{ ...option, value: id }] : []
      })
    )
  }
  const seen = new Set<string>()
  return entries.flatMap((entry): ProviderModelOption[] => {
    const id = stringField(entry, "value")
    if (!id || seen.has(id)) return []
    seen.add(id)
    const label = stringField(entry, "name") ?? id
    const reasoningEffort = parseReasoningEffort(id, label)
    return [{ id, label, ...(reasoningEffort ? { reasoningEffort } : {}) }]
  })
}

/** Creates a bounded child process for one ACP session. */
function spawnAcpProcess(
  command: ProviderCommand,
  workspaceDirectory: string,
  env?: NodeJS.ProcessEnv
): AcpChildProcess {
  return spawn(command.executable, command.args, {
    cwd: workspaceDirectory,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as AcpChildProcess
}

/** Implements the request and notification subset required by ACP text turns. */
class AcpJsonRpcClient {
  private readonly child: AcpChildProcess
  private readonly decoder = new StringDecoder("utf8")
  private readonly listeners = new Set<(event: ProviderEvent) => void>()
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly requestTimeoutMs: number
  private readonly maxLineBytes: number
  private nextRequestId = 1
  private inputBuffer = ""
  private closed = false
  private processClosed = false
  private loadSession = false
  private resumeSupported = false
  private streamBytes = 0
  private outputBytes = 0
  private activeSessionId?: string
  private readonly approvalHandler?: ProviderApprovalHandler
  private readonly requestHandler?: AcpRequestHandler
  private agentCapabilities: Record<string, unknown> = {}
  private readonly configOptions = new Map<string, Set<string>>()
  private availableModes?: Set<string>
  private modelConfigId?: string
  private legacyModelSelector = false
  private modelOptions = new Map<string, ProviderModelOption>()
  private readonly activeReverseRequests = new Map<JsonRpcId, AbortController>()

  /** Attaches readers and lifecycle handlers to a new ACP process. */
  constructor(
    child: AcpChildProcess,
    options: {
      requestTimeoutMs?: number
      maxLineBytes?: number
      approvalHandler?: ProviderApprovalHandler
      requestHandler?: AcpRequestHandler
    } = {}
  ) {
    this.child = child
    this.approvalHandler = options.approvalHandler
    this.requestHandler = options.requestHandler
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_LINE_BYTES
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0)
      throw new AcpProviderError(
        "invalid-input",
        "ACP request timeout is invalid"
      )
    if (!Number.isInteger(this.maxLineBytes) || this.maxLineBytes <= 0)
      throw new AcpProviderError("invalid-input", "ACP line limit is invalid")
    child.stdout.on("data", (chunk: unknown) => this.handleChunk(chunk))
    child.stdout.on("end", () => this.closeWithError("ACP process ended"))
    child.stderr?.on("data", () => {
      // Provider stderr may contain credentials or source text. Consume it only.
    })
    child.stdin.on("error", (error: unknown) =>
      this.closeWithError("ACP process input failed", error)
    )
    child.on("error", (error: unknown) =>
      this.closeWithError("ACP process failed", error)
    )
    child.on("close", () => {
      this.processClosed = true
      this.closeWithError("ACP process closed")
    })
  }

  /** Subscribes to normalized ACP activity and text events. */
  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Completes the ACP initialize handshake. */
  async initialize(): Promise<{
    authMethods: readonly ProviderAuthMethod[]
    canDisconnect: boolean
  }> {
    const result = record(
      await this.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "blitz", title: "Blitz", version: "0.0.1" },
        clientCapabilities: {
          auth: { terminal: false },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      })
    )
    if (result?.protocolVersion !== 1)
      throw new AcpProviderError(
        "protocol",
        "ACP protocol version is unsupported"
      )
    const capabilities = record(result?.agentCapabilities)
    this.agentCapabilities = capabilities ?? {}
    this.loadSession = capabilities?.loadSession === true
    this.resumeSupported = !!record(
      record(capabilities?.sessionCapabilities)?.resume
    )
    const auth = record(capabilities?.auth)
    const authMethods = Array.isArray(result?.authMethods)
      ? result.authMethods.flatMap((value): ProviderAuthMethod[] => {
          const method = record(value)
          const id = stringField(method, "id")
          const name = stringField(method, "name")
          if (!id || !name) return []
          return [
            {
              id,
              name,
              ...(stringField(method, "description")
                ? { description: stringField(method, "description") }
                : {}),
              type:
                stringField(method, "type") === "terminal"
                  ? "terminal"
                  : "agent",
            },
          ]
        })
      : []
    return {
      authMethods,
      canDisconnect: !!record(auth?.logout),
    }
  }

  /** Runs one provider-owned login method after initialization. */
  async authenticate(methodId: string): Promise<void> {
    if (!methodId.trim())
      throw new AcpProviderError("invalid-input", "Login method is required")
    await this.request("authenticate", { methodId })
  }

  /** Clears credentials when the initialized provider advertised logout support. */
  async logout(): Promise<void> {
    await this.request("logout", {})
  }

  /** Starts one ACP session with MCP disabled at the protocol boundary. */
  async startSession(
    workspaceDirectory: string,
    model?: string
  ): Promise<{ sessionId: string; models: readonly ProviderModelOption[] }> {
    const result = record(
      await this.request("session/new", {
        cwd: workspaceDirectory,
        mcpServers: [],
      })
    )
    const sessionId = stringField(result, "sessionId")
    if (!sessionId)
      throw new AcpProviderError("protocol", "ACP did not return a session ID")
    this.recordSessionOptions(result)
    const models = parseAcpModelOptions(result)
    this.modelOptions = new Map(models.map((option) => [option.id, option]))
    await this.trySelectModel(sessionId, model)
    return { sessionId, models }
  }

  /** Loads a provider-owned session when the ACP runtime supports resuming it. */
  async resumeSession(
    workspaceDirectory: string,
    sessionId: string,
    model?: string
  ): Promise<string> {
    if (!sessionId.trim())
      throw new AcpProviderError("invalid-input", "ACP session ID is required")
    // The caller can rebuild history on a fresh session before any turn is accepted.
    if (!this.loadSession && !this.resumeSupported)
      throw new AcpProviderError(
        "transport",
        "ACP cannot resume this session; replay the conversation in a new session"
      )
    const result = record(
      await this.request(
        this.resumeSupported ? "session/resume" : "session/load",
        {
          sessionId,
          cwd: workspaceDirectory,
          mcpServers: [],
        }
      )
    )
    const loadedId = stringField(result, "sessionId") ?? sessionId
    this.recordSessionOptions(result)
    const models = parseAcpModelOptions(result)
    this.modelOptions = new Map(models.map((option) => [option.id, option]))
    await this.trySelectModel(loadedId, model)
    return loadedId
  }

  /** Reasserts the native mode before every prompt, including resumed sessions. */
  async selectMode(sessionId: string, modeId: string): Promise<void> {
    if (this.availableModes && !this.availableModes.has(modeId))
      throw new AcpProviderError(
        "invalid-input",
        "ACP mode is not advertised by this provider"
      )
    await this.request("session/set_mode", { sessionId, modeId })
    this.activeSessionId = sessionId
  }

  /** Sends one prompt and waits for the ACP request response. */
  async prompt(sessionId: string, prompt: string): Promise<void> {
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: prompt },
    ]
    if (this.promptImages.length) content.push(...this.promptImages)
    await this.request("session/prompt", {
      sessionId,
      prompt: content,
    }, MAX_PROMPT_BYTES)
  }

  private promptImages: Array<Record<string, unknown>> = []

  /** Sets native ACP image blocks after capability negotiation. */
  setPromptImages(images: Array<Record<string, unknown>>): void {
    this.promptImages = images
  }

  /** Returns whether initialization advertised native image prompt support. */
  supportsPromptImages(): boolean {
    return Boolean(record(this.agentCapabilities.promptCapabilities)?.image)
  }

  /** Cancels the active ACP prompt without waiting for another model response. */
  cancel(sessionId: string): void {
    if (this.closed) return
    for (const controller of this.activeReverseRequests.values())
      controller.abort()
    this.write({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    })
  }

  /** Closes the child process and rejects any in-flight protocol requests. */
  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.activeReverseRequests.values())
      controller.abort()
    this.activeReverseRequests.clear()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AcpProviderError("transport", "ACP connection closed"))
      this.pending.delete(id)
    }
    this.child.stdin.end()
    if (!this.processClosed) {
      this.child.kill("SIGTERM")
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      if (!this.processClosed) this.child.kill("SIGKILL")
    }
  }

  /** Selects an explicit model or fails instead of silently using a different model. */
  private async trySelectModel(
    sessionId: string,
    model: string | undefined
  ): Promise<void> {
    if (!model?.trim() || model === "default") return
    const supported = this.modelConfigId
      ? this.configOptions.get(this.modelConfigId)
      : undefined
    if (this.legacyModelSelector && !this.modelOptions.has(model))
      throw new AcpProviderError(
        "invalid-input",
        "The selected ACP model is not advertised by this provider"
      )
    if (supported && !supported.has(model))
      throw new AcpProviderError(
        "invalid-input",
        "The selected ACP model is not advertised by this provider"
      )
    const selected = this.modelOptions.get(model)
    const effort = this.requestedEffort
    if (
      effort &&
      effort !== "default" &&
      this.modelOptions.size > 0 &&
      selected?.reasoningEffort !== effort
    )
      throw new AcpProviderError(
        "invalid-input",
        "The selected ACP model does not support the requested reasoning effort"
      )
    if (this.legacyModelSelector) {
      await this.request("session/set_model", { sessionId, modelId: model })
    } else if (this.modelConfigId) {
      await this.request("session/set_config_option", {
        sessionId,
        configId: this.modelConfigId,
        value: model,
      })
    } else {
      throw new AcpProviderError(
        "invalid-input",
        "ACP did not advertise a model selector"
      )
    }
  }

  private requestedEffort?: ProviderSelection["effort"]

  /** Records the provider-neutral effort before native model validation. */
  setRequestedEffort(effort: ProviderSelection["effort"]): void {
    this.requestedEffort = effort
  }

  /** Stores session-advertised modes and config values before selecting any option. */
  private recordSessionOptions(
    value: Record<string, unknown> | undefined
  ): void {
    const modeContainer = record(value?.modes)
    const advertisedModes = Array.isArray(value?.availableModes)
      ? value.availableModes
      : Array.isArray(modeContainer?.availableModes)
        ? modeContainer.availableModes
        : []
    const modes = advertisedModes.flatMap((entry) => {
      const mode = record(entry)
      const id =
        stringField(mode, "id") ??
        stringField(mode, "modeId") ??
        (typeof entry === "string" ? entry : undefined)
      return id ? [id] : []
    })
    if (modes.length) this.availableModes = new Set(modes)
    const options = Array.isArray(value?.configOptions)
      ? value.configOptions
      : []
    for (const raw of options) {
      const option = record(raw)
      const id = stringField(option, "id")
      if (!id || !Array.isArray(option?.options)) continue
      const values = option.options.flatMap((entry) => {
        const item = record(entry)
        const value = stringField(item, "value")
        return value ? [value] : []
      })
      if (values.length) this.configOptions.set(id, new Set(values))
      if (option.category === "model" || id === "model") this.modelConfigId = id
    }
    const models = record(value?.models)
    if (Array.isArray(models?.availableModels) && !this.modelConfigId)
      this.legacyModelSelector = true
  }

  /** Writes one bounded JSON-RPC message to the provider process. */
  private write(
    message: Record<string, unknown>,
    maxBytes = this.maxLineBytes
  ): void {
    if (this.closed)
      throw new AcpProviderError("transport", "ACP connection is closed")
    const encoded = `${JSON.stringify(message)}\n`
    if (new TextEncoder().encode(encoded).byteLength > maxBytes)
      throw new AcpProviderError("invalid-input", "ACP request is too large")
    this.child.stdin.write(encoded)
  }

  /** Sends one correlated ACP request with a bounded response deadline. */
  private request(
    method: string,
    params?: unknown,
    maxBytes = this.maxLineBytes
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(
        new AcpProviderError("transport", "ACP connection is closed")
      )
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new AcpProviderError("timeout", `ACP request timed out: ${method}`)
        )
      }, this.requestTimeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({
          jsonrpc: "2.0",
          id,
          method,
          ...(params ? { params } : {}),
        }, maxBytes)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error("ACP write failed"))
      }
    })
  }

  /** Handles one stdout chunk and parses complete JSON-RPC lines. */
  private handleChunk(chunk: unknown): void {
    if (this.closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    this.streamBytes += bytes.length
    if (this.streamBytes > MAX_STREAM_BYTES) {
      this.closeWithError("ACP stream exceeded the configured limit")
      return
    }
    this.inputBuffer += this.decoder.write(bytes)
    while (true) {
      const newline = this.inputBuffer.indexOf("\n")
      if (newline < 0) {
        if (Buffer.byteLength(this.inputBuffer) > this.maxLineBytes)
          this.closeWithError("ACP response exceeded the line limit")
        break
      }
      const line = this.inputBuffer.slice(0, newline)
      this.inputBuffer = this.inputBuffer.slice(newline + 1)
      if (!line) continue
      if (new TextEncoder().encode(line).byteLength > this.maxLineBytes) {
        this.closeWithError("ACP response exceeded the line limit")
        return
      }
      try {
        this.handleMessage(JSON.parse(line) as unknown)
      } catch (error) {
        this.closeWithError("ACP response was invalid", error)
        return
      }
    }
  }

  /** Routes one parsed response, notification, or provider request. */
  private handleMessage(value: unknown): void {
    const message = record(value)
    if (!message)
      throw new AcpProviderError("protocol", "ACP message was invalid")
    const id = message.id
    if (
      (typeof id === "number" || typeof id === "string") &&
      this.pending.has(id) &&
      !message.method
    ) {
      const pending = this.pending.get(id)!
      this.pending.delete(id)
      clearTimeout(pending.timer)
      const error = record(message.error)
      if (error) {
        pending.reject(
          new AcpProviderError(
            "protocol",
            stringField(error, "message") ??
              `ACP request failed: ${pending.method}`
          )
        )
      } else pending.resolve(message.result)
      return
    }
    const method = stringField(message, "method")
    if (!method) return
    const params = message.params
    if (
      (typeof id === "number" || typeof id === "string") &&
      method !== "session/update"
    ) {
      if (method === "session/request_permission") {
        void this.respondPermission(id, params).catch((error: unknown) =>
          this.closeWithError("ACP approval failed", error)
        )
        return
      }
      if (method === "session/elicitation") {
        void this.respondElicitation(id, params).catch((error: unknown) =>
          this.closeWithError("ACP elicitation failed", error)
        )
        return
      }
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "Blitz denied this provider request" },
      })
      this.emit({ type: "request", requestId: id, method, params })
      return
    }
    this.emitAcpNotification(method, params)
  }

  /** Rejects unsupported ACP elicitation instead of pretending to implement form responses. */
  private async respondElicitation(
    id: JsonRpcId,
    params: unknown
  ): Promise<void> {
    const sessionId = stringField(record(params), "sessionId")
    if (this.activeReverseRequests.has(id)) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Duplicate ACP request ID" },
      })
      return
    }
    if (sessionId && sessionId !== this.activeSessionId) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32002, message: "ACP elicitation session is not active" },
      })
      return
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message: "ACP elicitation is unsupported by Blitz",
      },
    })
  }

  /** Returns only allow-once or cancellation, never a persistent provider grant. */
  private async respondPermission(
    id: JsonRpcId,
    params: unknown
  ): Promise<void> {
    if (this.activeReverseRequests.has(id)) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Duplicate ACP request ID" },
      })
      return
    }
    if (this.requestHandler) {
      const sessionId = stringField(record(params), "sessionId")
      if (!sessionId || sessionId !== this.activeSessionId) {
        this.write({
          jsonrpc: "2.0",
          id,
          result: { outcome: { outcome: "cancelled" } },
        })
        return
      }
      const controller = this.beginReverseRequest(id)
      try {
        let result: unknown
        try {
          result = await this.requestHandler({
            requestId: id,
            method: "session/request_permission",
            params,
            sessionId,
            signal: controller.signal,
          })
        } catch {
          result = { outcome: { outcome: "cancelled" } }
        }
        const validated = this.validatePermissionResult(params, result)
        if (!this.closed) this.write({ jsonrpc: "2.0", id, result: validated })
      } finally {
        this.activeReverseRequests.get(id)?.abort()
        this.activeReverseRequests.delete(id)
      }
      return
    }
    const input = record(params)
    const choices = Array.isArray(input?.options)
      ? input.options.map(record)
      : []
    const once = choices.find(
      (choice) =>
        choice?.kind === "allow_once" && typeof choice.optionId === "string"
    )
    const valid =
      input?.sessionId === this.activeSessionId &&
      record(input?.toolCall) &&
      Buffer.byteLength(JSON.stringify(params)) <= 20_000
    let decision: Awaited<ReturnType<ProviderApprovalHandler>> = false
    if (valid && once && this.approvalHandler) {
      const controller = this.beginReverseRequest(id)
      try {
        decision = await this.approvalHandler({
          requestId: id,
          method: "session/request_permission",
          params,
          signal: controller.signal,
        }).catch(() => false)
      } finally {
        this.activeReverseRequests.get(id)?.abort()
        this.activeReverseRequests.delete(id)
      }
    }
    const approved =
      typeof decision === "boolean" ? decision : decision.accepted
    const selectedOptionId =
      typeof decision === "boolean" ? undefined : decision.optionId
    if (this.closed) return
    this.write({
      jsonrpc: "2.0",
      id,
      result: {
        outcome: approved
          ? {
              outcome: "selected",
              optionId:
                selectedOptionId &&
                choices.some((choice) => choice?.optionId === selectedOptionId)
                  ? selectedOptionId
                  : once!.optionId,
            }
          : { outcome: "cancelled" },
      },
    })
  }

  /** Registers a reverse request and bounds its wait independently of the provider turn. */
  private beginReverseRequest(id: JsonRpcId): AbortController {
    if (this.activeReverseRequests.has(id))
      throw new AcpProviderError("protocol", "Duplicate ACP request ID")
    const controller = new AbortController()
    this.activeReverseRequests.set(id, controller)
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    })
    return controller
  }

  /** Whitelists native permission choices and refuses cross-session responses. */
  private validatePermissionResult(params: unknown, result: unknown): unknown {
    const input = record(params)
    if (input?.sessionId !== this.activeSessionId)
      return { outcome: { outcome: "cancelled" } }
    const response = record(result)
    const outcome = record(response?.outcome)
    if (outcome?.outcome === "cancelled") return result
    if (
      outcome?.outcome === "selected" &&
      typeof outcome.optionId === "string" &&
      Array.isArray(input?.options) &&
      input.options.some(
        (option) => record(option)?.optionId === outcome.optionId
      )
    )
      return result
    return { outcome: { outcome: "cancelled" } }
  }

  /** Converts ACP notifications into the provider event vocabulary. */
  private emitAcpNotification(method: string, params: unknown): void {
    const paramsRecord = record(params)
    const update = record(paramsRecord?.update)
    const content = record(update?.content)
    const sessionId = stringField(paramsRecord, "sessionId") ?? "unknown"
    if (
      update?.sessionUpdate === "agent_message_chunk" &&
      content?.type === "text" &&
      typeof content.text === "string" &&
      content.text.length > 0
    ) {
      this.outputBytes += Buffer.byteLength(content.text)
      if (this.outputBytes > MAX_OUTPUT_BYTES)
        throw new AcpProviderError(
          "transport",
          "ACP assistant output exceeded the configured limit"
        )
      this.emit({
        type: "text-delta",
        threadId: sessionId,
        turnId: "pending",
        delta: content.text,
      })
      return
    }
    if (
      update?.sessionUpdate === "agent_thought_chunk" &&
      (content?.type === "text" || content?.type === "thought") &&
      typeof content.text === "string" &&
      content.text.length > 0
    ) {
      this.outputBytes += Buffer.byteLength(content.text)
      if (this.outputBytes > MAX_OUTPUT_BYTES)
        throw new AcpProviderError(
          "transport",
          "ACP assistant output exceeded the configured limit"
        )
      this.emit({
        type: "thought-delta",
        threadId: sessionId,
        turnId: "pending",
        delta: content.text,
      })
      return
    }
    this.emit({ type: "activity", method, params })
  }

  /** Sends one event to all listeners while isolating listener failures. */
  private emit(event: ProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A display listener cannot corrupt the provider protocol.
      }
    }
  }

  /** Rejects pending requests once and records only a safe transport message. */
  private closeWithError(message: string, cause?: unknown): void {
    if (this.closed) return
    this.closed = true
    if (!this.processClosed) this.child.kill("SIGKILL")
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new AcpProviderError("transport", message, cause))
      this.pending.delete(id)
    }
  }
}

/** Inspects an ACP runtime and optionally tests whether it can create an authenticated session. */
export async function inspectAcpAuthentication(
  command: ProviderCommand,
  workspaceDirectory: string,
  options: {
    spawnProcess?: (
      command: ProviderCommand,
      workspaceDirectory: string
    ) => AcpChildProcess
    verifySession?: boolean
  } = {}
): Promise<{
  authenticated: boolean | null
  authMethods: readonly ProviderAuthMethod[]
  canDisconnect: boolean
  models?: readonly ProviderModelOption[]
}> {
  const child = options.spawnProcess
    ? options.spawnProcess(command, workspaceDirectory)
    : spawnAcpProcess(command, workspaceDirectory)
  const client = new AcpJsonRpcClient(child, { requestTimeoutMs: 30_000 })
  try {
    const initialized = await client.initialize()
    if (!options.verifySession) return { authenticated: null, ...initialized }
    try {
      const session = await client.startSession(workspaceDirectory)
      return { authenticated: true, models: session.models, ...initialized }
    } catch (error) {
      if (
        error instanceof Error &&
        /auth|credential|log in|login/i.test(error.message)
      )
        return { authenticated: false, ...initialized }
      throw error
    }
  } finally {
    await client.close()
  }
}

/** Runs a supported ACP connect or disconnect request without starting a model turn. */
export async function changeAcpAuthentication(
  command: ProviderCommand,
  workspaceDirectory: string,
  action: { type: "connect"; methodId: string } | { type: "disconnect" }
): Promise<void> {
  const child = spawnAcpProcess(command, workspaceDirectory)
  const client = new AcpJsonRpcClient(child, { requestTimeoutMs: 120_000 })
  try {
    const initialized = await client.initialize()
    if (action.type === "connect") {
      if (
        !initialized.authMethods.some(
          (method) => method.id === action.methodId && method.type === "agent"
        )
      )
        throw new AcpProviderError(
          "invalid-input",
          "This login method is not available"
        )
      await client.authenticate(action.methodId)
      return
    }
    if (!initialized.canDisconnect)
      throw new AcpProviderError(
        "invalid-input",
        "This provider does not support disconnecting from Blitz"
      )
    await client.logout()
  } finally {
    await client.close()
  }
}

/** Runs one ACP text turn for a provider with an ACP-compatible executable. */
export async function runAcpTextTurn(
  request: ProviderTextTurnRequest,
  options: {
    command: ProviderCommand
    providerInstanceId: string
    spawnProcess?: (
      command: ProviderCommand,
      workspaceDirectory: string
    ) => AcpChildProcess
    onEvent?: (event: ProviderEvent) => void
    approvalHandler?: ProviderApprovalHandler
    requestHandler?: AcpRequestHandler
  }
): Promise<ProviderTextTurnResult> {
  const provider = request.selection.providerId
  if (request.sandbox === "workspace-write")
    throw new AcpProviderError(
      "invalid-input",
      "This provider cannot enforce a workspace-only OS sandbox. Choose approval mode or full access."
    )
  if (!isAbsolute(request.workspaceDirectory))
    throw new AcpProviderError(
      "invalid-input",
      "Provider workspace must be an absolute path"
    )
  if (!request.prompt.trim())
    throw new AcpProviderError("invalid-input", "Provider prompt is required")
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new AcpProviderError("invalid-input", "Provider timeout is invalid")
  request.signal?.throwIfAborted()
  const modeId =
    provider === "opencode"
      ? `blitz-${randomUUID()}`
      : request.approvalPolicy === "full-access"
        ? "yolo"
        : "default"
  const child = options.spawnProcess
    ? options.spawnProcess(options.command, request.workspaceDirectory)
    : spawnAcpProcess(
        options.command,
        request.workspaceDirectory,
        provider === "opencode"
          ? openCodeEnvironment(request, modeId)
          : undefined
      )
  const client = new AcpJsonRpcClient(child, {
    requestTimeoutMs: timeoutMs,
    approvalHandler:
      !request.ephemeral &&
      request.sandbox !== "read-only" &&
      request.webSearchMode !== "disabled" &&
      (request.approvalPolicy === "on-request" ||
        request.approvalPolicy === "untrusted")
        ? options.approvalHandler
        : undefined,
    requestHandler:
      !request.ephemeral &&
      request.sandbox !== "read-only" &&
      request.webSearchMode !== "disabled" &&
      request.approvalPolicy !== "never"
        ? options.requestHandler
        : undefined,
  })
  const signal = request.signal
  let sessionId: string | undefined
  const turnId = randomUUID()
  const startTime = Date.now()
  let text = ""
  let thought = ""
  let semanticOutput = false
  let settled = false
  let prompting = false
  const emit = (event: ProviderEvent): void => {
    if (event.type === "text-delta") {
      if (!prompting || event.threadId !== sessionId) return
      const normalized = { ...event, turnId }
      text += normalized.delta
      options.onEvent?.(normalized)
    } else if (event.type === "thought-delta") {
      if (!prompting || event.threadId !== sessionId) return
      const normalized = { ...event, turnId }
      thought += normalized.delta
      options.onEvent?.(normalized)
    } else options.onEvent?.(event)
    if (prompting && event.type !== "turn-started") semanticOutput = true
  }
  const unsubscribe = client.onEvent(emit)
  let rejectInterruption: ((error: AcpProviderError) => void) | undefined
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject
  })
  const interrupt = (error: AcpProviderError): void => {
    if (sessionId) {
      try {
        client.cancel(sessionId)
      } catch {
        // The provider may have closed before cancellation reached its stdin.
      }
    }
    rejectInterruption?.(error)
  }
  const abortHandler = (): void => {
    interrupt(new AcpProviderError("aborted", "Provider turn was interrupted"))
  }
  signal?.addEventListener("abort", abortHandler, { once: true })
  const timeout = setTimeout(
    () => interrupt(new AcpProviderError("timeout", "Provider turn timed out")),
    timeoutMs
  )
  try {
    const operation = (async (): Promise<ProviderTextTurnResult> => {
      await client.initialize()
      client.setRequestedEffort(request.selection.effort)
      if (request.attachments?.length) {
        if (!client.supportsPromptImages())
          throw new AcpProviderError(
            "invalid-input",
            "This ACP provider does not support image attachments"
          )
        client.setPromptImages(
          request.attachments.map((attachment) => ({
            type: "image",
            mimeType: attachment.mimeType,
            data: attachment.data,
          }))
        )
      }
      sessionId = request.session?.providerSessionId
        ? await client.resumeSession(
            request.workspaceDirectory,
            request.session.providerSessionId,
            request.selection.model
          )
        : (
            await client.startSession(
              request.workspaceDirectory,
              request.selection.model
            )
          ).sessionId
      await client.selectMode(sessionId, modeId)
      const activeSessionId = sessionId
      options.onEvent?.({
        type: "turn-started",
        threadId: activeSessionId,
        turnId,
      })
      prompting = true
      if ((request.developerInstructions?.length ?? 0) > 16_000)
        throw new AcpProviderError(
          "invalid-input",
          "Provider application instructions exceed the 16,000 character limit"
        )
      const prompt = request.developerInstructions?.trim()
        ? `<blitz_application_context>\n${request.developerInstructions.trim()}\n</blitz_application_context>\n\n${request.prompt}`
        : request.prompt
      await client.prompt(activeSessionId, prompt)
      if (signal?.aborted)
        throw new AcpProviderError("aborted", "Provider turn was interrupted")
      if (!text.trim() && !semanticOutput)
        throw new AcpProviderError(
          "transport",
          "Provider completed without semantic output"
        )
      settled = true
      return {
        providerId: request.selection.providerId,
        providerInstanceId: options.providerInstanceId,
        threadId: activeSessionId,
        turnId,
        text,
        ...(thought.trim() ? { thought } : {}),
        durationMs: Date.now() - startTime,
      }
    })()
    return await Promise.race([operation, interruption])
  } catch (error) {
    if (signal?.aborted)
      throw new AcpProviderError(
        "aborted",
        "Provider turn was interrupted",
        error
      )
    if (error instanceof AcpProviderError) throw error
    throw new AcpProviderError("transport", "Provider turn failed", error)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abortHandler)
    unsubscribe()
    if (!settled && sessionId) {
      try {
        client.cancel(sessionId)
      } catch {
        // Cleanup continues even when the process has already exited.
      }
    }
    await client.close().catch(() => undefined)
  }
}
