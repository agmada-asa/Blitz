/** Runs bounded non-interactive Claude Code turns through stream-json output. */

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { isAbsolute } from "node:path"
import { StringDecoder } from "node:string_decoder"

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
function claudeArgs(request: ProviderTextTurnRequest): string[] {
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
    args.push("--model", request.selection.model)
  if (request.sandbox === "read-only") args.push("--permission-mode", "plan")
  return args
}

/** Starts one Claude Code process without invoking a shell. */
function spawnClaude(
  command: ProviderCommand,
  request: ProviderTextTurnRequest
): ClaudeCodeChildProcess {
  return spawn(command.executable, [...command.args, ...claudeArgs(request)], {
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

  /** Parses stdout chunks while preserving partial UTF-8 and JSON lines. */
  const handleChunk = (chunk: unknown): void => {
    inputBuffer += decoder.write(chunk as string)
    while (true) {
      const newline = inputBuffer.indexOf("\n")
      if (newline < 0) break
      const line = inputBuffer.slice(0, newline)
      inputBuffer = inputBuffer.slice(newline + 1)
      handleLine(line)
    }
  }

  child.stdout.on("data", handleChunk)
  child.stdout.on("end", () => {
    if (inputBuffer.trim()) handleLine(inputBuffer)
    ended = true
  })
  child.stderr?.on("data", () => {
    // Provider stderr can contain source snippets or credentials. Never retain it.
  })
  const closePromise = new Promise<void>((resolve) => {
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
    await new Promise<void>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM")
        reject(
          new ClaudeCodeProviderError("timeout", "Provider turn timed out")
        )
      }, timeoutMs)
      abortHandler = () => {
        child.kill("SIGTERM")
        reject(
          new ClaudeCodeProviderError(
            "aborted",
            "Provider turn was interrupted"
          )
        )
      }
      request.signal?.addEventListener("abort", abortHandler, { once: true })
      const check = (): void => {
        if (ended) resolve()
        else setTimeout(check, 20)
      }
      check()
    })
    await closePromise
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
