/** Runs bounded non-interactive Claude Code turns through stream-json output. */

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

import { getSupportedAiReasoningEffortsForProvider } from "../../ai-model-settings.ts"

import type {
  ProviderCommand,
  ProviderEvent,
  ProviderTextTurnRequest,
  ProviderTextTurnResult,
} from "./types.ts"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 250_000

/** Child-process surface needed by the Claude Code stream parser. */
export interface ClaudeCodeChildProcess {
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
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
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
  // These turns already contain their source context. Remove all model tools and
  // local customizations so imported text cannot trigger filesystem or network work.
  args.push(
    "--restricted",
    "--safe-mode",
    "--tools",
    "",
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--settings",
    '{"disableAllHooks":true}',
    "--permission-mode",
    "dontAsk"
  )
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
    stdio: ["ignore", "pipe", "pipe"],
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
  }
): Promise<ProviderTextTurnResult> {
  if (request.approvalPolicy && request.approvalPolicy !== "never")
    throw new ClaudeCodeProviderError(
      "invalid-input",
      "Claude Code only supports never-approve turns in Blitz"
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
  let inputBuffer = ""
  let text = ""
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
    sessionId = sessionIdFromEvent(event) ?? sessionId
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
    return {
      providerId: request.selection.providerId,
      providerInstanceId: options.providerInstanceId,
      threadId: sessionId,
      turnId,
      text,
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
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (abortHandler) request.signal?.removeEventListener("abort", abortHandler)
    if (!ended) child.kill("SIGKILL")
  }
}
