/** Runs bounded non-interactive Claude Code turns through stream-json output. */

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

import { getSupportedAiReasoningEffortsForProvider } from "../../ai-model-settings.ts"

import type {
  ProviderApprovalHandler,
  ProviderCommand,
  ProviderEvent,
  ProviderTextTurnRequest,
  ProviderTextTurnResult,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 250_000

/** Child-process surface needed by the Claude Code stream parser. */
export interface ClaudeCodeChildProcess {
  /** Bidirectional control channel used for interactive tool approvals. */
  readonly stdin?: {
    write(chunk: string): boolean
    end(): void
    on(event: "error", listener: (...args: unknown[]) => void): void
  }
  /** Standard output carrying JSONL events. */
  readonly stdout: {
    on(event: "data" | "end", listener: (...args: unknown[]) => void): void
  }
  /** Standard error consumed without exposing provider output. */
  readonly stderr?: {
    on(event: "data", listener: (...args: unknown[]) => void): void
  }
  /** Child lifecycle events. */
  on(event: "error" | "close", listener: (...args: unknown[]) => void): void
  /** Stops the child process on cancellation or timeout. */
  kill(signal?: NodeJS.Signals): boolean
}

/** Safe failure from a Claude Code process or stream. */
export class ClaudeCodeProviderError extends Error {
  /** Machine-readable provider failure category. */
  readonly code: "invalid-input" | "aborted" | "timeout" | "transport"
  /** Underlying process detail retained for server diagnostics. */
  readonly cause?: unknown

  /** Creates a bounded Claude Code provider error. */
  constructor(
    code: ClaudeCodeProviderError["code"],
    message: string,
    cause?: unknown
  ) {
    super(message)
    this.name = "ClaudeCodeProviderError"
    this.code = code
    this.cause = cause
  }
}

/** Returns an object-like record from an untrusted stream event. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined
  return value as Record<string, unknown>
}

/** Extracts one text fragment from the known Claude stream-json event shapes. */
function textFromEvent(value: unknown): string | undefined {
  const event = record(value)
  if (!event) return undefined
  if (event.type === "result" && typeof event.result === "string")
    return event.result
  const nested = record(event.event)
  const delta = record(nested?.delta)
  if (nested?.type === "content_block_delta" && typeof delta?.text === "string")
    return delta.text
  if (event.type === "content_block_delta" && typeof event.text === "string")
    return event.text
  const message = record(event.message)
  if (Array.isArray(message?.content)) {
    return (
      message.content
        .map((block) => {
          const item = record(block)
          return item?.type === "text" && typeof item.text === "string"
            ? item.text
            : ""
        })
        .join("") || undefined
    )
  }
  return undefined
}

/** Extracts one thought fragment from the known Claude stream-json event shapes. */
function thoughtFromEvent(value: unknown): string | undefined {
  const event = record(value)
  if (!event) return undefined
  const nested = record(event.event)
  const delta = record(nested?.delta)
  if (
    nested?.type === "content_block_delta" &&
    typeof delta?.thinking === "string"
  )
    return delta.thinking
  if (
    event.type === "content_block_delta" &&
    typeof event.thinking === "string"
  )
    return event.thinking
  const message = record(event.message)
  if (Array.isArray(message?.content)) {
    return (
      message.content
        .map((block) => {
          const item = record(block)
          return item?.type === "thinking" && typeof item.thinking === "string"
            ? item.thinking
            : ""
        })
        .join("") || undefined
    )
  }
  return undefined
}

/** Extracts a provider session identifier from one Claude event. */
function sessionIdFromEvent(value: unknown): string | undefined {
  const event = record(value)
  const sessionId = event?.session_id ?? event?.sessionId
  return typeof sessionId === "string" && sessionId.trim()
    ? sessionId
    : undefined
}

/** Builds the safe non-interactive Claude Code command line. */
export function claudeArgs(request: ProviderTextTurnRequest): string[] {
  // Claude Code requires verbose mode for stream-json print output.
  const args = [
    "-p",
    ...(request.approvalPolicy === "on-request" &&
    request.sandbox !== "read-only" &&
    request.webSearchMode !== "disabled" &&
    !request.ephemeral
      ? []
      : [request.prompt]),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ]
  if (request.session?.providerSessionId)
    args.push("--resume", request.session.providerSessionId)
  if (request.selection.model.trim() && request.selection.model !== "default")
    args.push(
      "--model",
      request.selection.model.replace(/^claude-(sonnet|opus|haiku)$/, "$1")
    )
  const effort = request.selection.effort
  if (effort && effort !== "default") {
    const supported = getSupportedAiReasoningEffortsForProvider(
      "claude-code",
      request.selection.model
    )
    if (!supported.includes(effort))
      throw new ClaudeCodeProviderError(
        "invalid-input",
        "Claude Code reasoning level is unsupported for this model"
      )
    args.push("--effort", effort)
  }
  const isolated =
    request.sandbox === "read-only" ||
    request.ephemeral ||
    !request.approvalPolicy ||
    request.approvalPolicy === "never" ||
    request.webSearchMode === "disabled"
  const toolNames = [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "Bash",
    "WebFetch",
    "WebSearch",
  ]
  args.push(
    "--safe-mode",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}'
  )
  if (isolated) {
    args.push(
      "--restricted",
      "--tools",
      "",
      "--disallowedTools",
      "*",
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "dontAsk"
    )
  } else if (request.approvalPolicy === "full-access") {
    args.push(
      "--tools",
      toolNames.join(","),
      "--settings",
      '{"disableAllHooks":true}',
      "--permission-mode",
      "bypassPermissions",
      "--dangerously-skip-permissions"
    )
  } else {
    args.push(
      "--restricted",
      "--tools",
      toolNames.join(","),
      "--settings",
      JSON.stringify({
        disableAllHooks: true,
        permissions: { ask: toolNames },
      }),
      "--permission-mode",
      "default",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool",
      "stdio"
    )
  }
  if (request.ephemeral) args.push("--no-session-persistence")
  return args
}

/** Starts one Claude Code process without invoking a shell. */
function spawnClaude(
  command: ProviderCommand,
  request: ProviderTextTurnRequest
): ClaudeCodeChildProcess {
  const env = { ...process.env }
  // An inherited effort override must not silently win over the saved selection.
  if (request.selection.effort) delete env.CLAUDE_CODE_EFFORT_LEVEL
  return spawn(command.executable, [...command.args, ...claudeArgs(request)], {
    env,
    cwd: request.workspaceDirectory,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ClaudeCodeChildProcess
}

/** Runs one bounded Claude Code prompt and normalizes its streamed output. */
export async function runClaudeCodeTextTurn(
  request: ProviderTextTurnRequest,
  options: {
    command: ProviderCommand
    providerInstanceId: string
    spawnProcess?: (
      command: ProviderCommand,
      request: ProviderTextTurnRequest
    ) => ClaudeCodeChildProcess
    onEvent?: (event: ProviderEvent) => void
    approvalHandler?: ProviderApprovalHandler
  }
): Promise<ProviderTextTurnResult> {
  if (request.approvalPolicy === "untrusted")
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Claude Code supports on-request approvals, not Codex untrusted mode"
    )
  if (request.sandbox === "workspace-write")
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Claude Code cannot enforce Blitz's workspace-only OS sandbox. Choose approval mode or full access."
    )
  if (!isAbsolute(request.workspaceDirectory))
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Provider workspace must be an absolute path"
    )
  if (!request.prompt.trim())
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Provider prompt is required"
    )
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Provider timeout is invalid"
    )
  request.signal?.throwIfAborted()
  const child = options.spawnProcess
    ? options.spawnProcess(options.command, request)
    : spawnClaude(options.command, request)
  const decoder = new StringDecoder("utf8")
  const startedAt = Date.now()
  let inputBuffer = ""
  let text = ""
  let thought = ""
  let outputBytes = 0
  let sessionId = request.session?.providerSessionId ?? randomUUID()
  let exitCode: number | null = null
  let processError: unknown
  let ended = false
  let streamBytes = 0
  let streamFailed = false
  let failStream: (error: unknown) => void = () => undefined
  const turnId = randomUUID()
  let emittedStarted = false
  const interactive =
    request.approvalPolicy === "on-request" &&
    request.sandbox !== "read-only" &&
    request.webSearchMode !== "disabled" &&
    !request.ephemeral
  const permissionControllers = new Map<string, AbortController>()
  const initializeId = randomUUID()
  let initialized = false

  /** Writes control frames without invoking a shell or accepting persistent grants. */
  const writeControl = (value: unknown): void => {
    if (!child.stdin)
      throw new ClaudeCodeProviderError(
        "transport",
        "Claude approval input is unavailable"
      )
    child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  /** Handles SDK permission callbacks; unavailable, oversized, or cancelled reviews deny. */
  const approveTool = async (event: Record<string, unknown>): Promise<void> => {
    const control = record(event.request)
    const id = event.request_id
    if (typeof id !== "string") return
    const approvalAbort = new AbortController()
    permissionControllers.set(id, approvalAbort)
    const allowed =
      control?.subtype === "can_use_tool" &&
      typeof control.tool_name === "string" &&
      record(control.input) &&
      JSON.stringify(control).length <= 20_000 &&
      options.approvalHandler
        ? await options
            .approvalHandler({
              method: "claude/can_use_tool",
              params: control,
              signal: approvalAbort.signal,
            })
            .catch(() => false)
        : false
    permissionControllers.delete(id)
    if (
      ended ||
      streamFailed ||
      request.signal?.aborted ||
      approvalAbort.signal.aborted
    )
      return
    writeControl({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: id,
        response: allowed
          ? { behavior: "allow", updatedInput: control!.input }
          : { behavior: "deny", message: "Blitz denied this operation" },
      },
    })
  }

  /** Emits a turn-started event once a stable local session identity exists. */
  const emitStarted = (): void => {
    if (emittedStarted) return
    emittedStarted = true
    options.onEvent?.({ type: "turn-started", threadId: sessionId, turnId })
  }

  /** Parses one complete Claude JSONL event and forwards bounded text. */
  const handleLine = (line: string): void => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line) as unknown
    } catch {
      // Claude may print a human diagnostic when the installed version lacks stream-json.
      return
    }
    const frame = record(event)
    if (
      interactive &&
      frame?.type === "control_response" &&
      record(frame.response)?.request_id === initializeId
    ) {
      if (record(frame.response)?.subtype !== "success")
        throw new ClaudeCodeProviderError(
          "transport",
          "Claude approval initialization failed"
        )
      if (!initialized) {
        initialized = true
        writeControl({
          type: "user",
          session_id: "",
          message: { role: "user", content: request.prompt },
          parent_tool_use_id: null,
        })
      }
      return
    }
    if (interactive && frame?.type === "control_request") {
      void approveTool(frame).catch(failStream)
      return
    }
    if (
      frame?.type === "control_cancel_request" &&
      typeof frame.request_id === "string"
    ) {
      permissionControllers.get(frame.request_id)?.abort()
      return
    }
    if (frame?.type === "result") {
      if (interactive) child.stdin?.end()
      if (frame.is_error === true)
        throw new ClaudeCodeProviderError(
          "transport",
          "Claude Code could not complete the turn"
        )
    }
    sessionId = sessionIdFromEvent(event) ?? sessionId
    const thoughtFragment = thoughtFromEvent(event)
    if (thoughtFragment) {
      emitStarted()
      thought += thoughtFragment
      options.onEvent?.({
        type: "thought-delta",
        threadId: sessionId,
        turnId,
        delta: thoughtFragment,
      })
    }
    const fragment = textFromEvent(event)
    if (!fragment) return
    const eventRecord = record(event)
    if (
      text.length > 0 &&
      (eventRecord?.type === "result" || eventRecord?.type === "assistant")
    )
      return
    emitStarted()
    outputBytes += new TextEncoder().encode(fragment).byteLength
    if (outputBytes > MAX_OUTPUT_BYTES)
      throw new ClaudeCodeProviderError(
        "transport",
        "Claude Code assistant output exceeded the configured limit"
      )
    text += fragment
    options.onEvent?.({
      type: "text-delta",
      threadId: sessionId,
      turnId,
      delta: fragment,
    })
  }

  const closePromise = new Promise<void>((resolve, reject) => {
    /** Rejects stream failures through the awaited promise, never the event emitter. */
    failStream = (error: unknown): void => {
      streamFailed = true
      reject(error)
      child.kill("SIGKILL")
    }
    /** Parses bounded stdout bytes while retaining partial UTF-8 sequences. */
    child.stdout.on("data", (chunk: unknown) => {
      if (streamFailed) return
      try {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk))
        streamBytes += bytes.length
        if (streamBytes > 2_000_000)
          throw new ClaudeCodeProviderError(
            "transport",
            "Claude Code stream exceeded the configured limit"
          )
        inputBuffer += decoder.write(bytes)
        let newline: number
        while ((newline = inputBuffer.indexOf("\n")) >= 0) {
          const line = inputBuffer.slice(0, newline)
          inputBuffer = inputBuffer.slice(newline + 1)
          handleLine(line)
        }
      } catch (error) {
        failStream(error)
      }
    })
    child.stdout.on("end", () => {
      if (streamFailed) return
      try {
        inputBuffer += decoder.end()
        if (inputBuffer.trim()) handleLine(inputBuffer)
        inputBuffer = ""
      } catch (error) {
        failStream(error)
      }
    })
    child.stderr?.on("data", () => {
      // Discard diagnostics, which may contain private source text.
    })
    child.on("close", (...args: unknown[]) => {
      exitCode = typeof args[0] === "number" ? args[0] : null
      ended = true
      resolve()
    })
    child.on("error", (error: unknown) => {
      processError = error
      ended = true
      resolve()
    })
  })
  child.stdin?.on("error", failStream)
  if (interactive) {
    try {
      writeControl({
        type: "control_request",
        request_id: initializeId,
        request: { subtype: "initialize", hooks: null },
      })
    } catch (error) {
      failStream(error)
    }
  } else child.stdin?.end()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  try {
    await Promise.race([
      closePromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(
            new ClaudeCodeProviderError("timeout", "Provider turn timed out")
          )
        }, timeoutMs)
        abortHandler = () => {
          reject(
            new ClaudeCodeProviderError(
              "aborted",
              "Provider turn was interrupted"
            )
          )
        }
        request.signal?.addEventListener("abort", abortHandler, { once: true })
        if (request.signal?.aborted) abortHandler()
      }),
    ])
    if (processError)
      throw new ClaudeCodeProviderError(
        "transport",
        "Claude Code failed",
        processError
      )
    if (exitCode !== null && exitCode !== 0)
      throw new ClaudeCodeProviderError(
        "transport",
        "Claude Code exited before completing the turn"
      )
    if (!text.trim())
      throw new ClaudeCodeProviderError(
        "transport",
        "Claude Code completed without assistant text"
      )
    const durationMs = Math.max(0, Date.now() - startedAt)
    return {
      providerId: request.selection.providerId,
      providerInstanceId: options.providerInstanceId,
      threadId: sessionId,
      turnId,
      text,
      thought: thought.trim() ? thought : undefined,
      durationMs,
    }
  } catch (error) {
    if (request.signal?.aborted)
      throw new ClaudeCodeProviderError(
        "aborted",
        "Provider turn was interrupted",
        error
      )
    if (error instanceof ClaudeCodeProviderError) throw error
    throw new ClaudeCodeProviderError(
      "transport",
      "Claude Code turn failed",
      error
    )
  } finally {
    streamFailed = true
    for (const controller of permissionControllers.values()) controller.abort()
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (abortHandler) request.signal?.removeEventListener("abort", abortHandler)
    if (!ended) child.kill("SIGKILL")
  }
}
