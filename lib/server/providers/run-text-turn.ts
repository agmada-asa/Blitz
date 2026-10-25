/**
 * Routes one text turn through the selected provider and normalizes its events.
 *
 * Codex and Claude Code run through agent-engines: this module turns Blitz's
 * access settings into each runtime's thread options and hands the turn to
 * `engine-turn.ts`. OpenCode runs through Blitz's own ACP adapter.
 */
import type {
  AgentRequest,
  ClaudeThreadOptions,
  CodexEngineOptions,
  CodexThreadOptions,
  Engine,
  ThreadOptions,
  TurnLimits,
} from "agent-engines"

import {
  CardChatError,
  type CardChatEvent,
  type CardChatResult,
} from "../card-chat.ts"
import { claudeBackgroundLimits } from "../spending-limits.ts"
import {
  getSupportedAiReasoningEffortsForProvider,
  type AiProviderId,
  type AiReasoningEffort,
} from "../../ai-model-settings.ts"
import {
  providerExecutionInstructions,
  resolveProviderExecution,
} from "../../provider-execution.ts"
import {
  runAcpTextTurn,
  AcpProviderError,
  type AcpRequestHandler,
} from "./acp.ts"
import {
  checkProviderAvailability,
  providerCommand,
  providerInstanceId,
} from "./registry.ts"
import { validateCodexModelSelection } from "./codex-models.ts"
import { codexRuntimeInstructionsIfInstalled } from "./codex-runtime.ts"
import {
  createClaudeEngine,
  createCodexEngine,
  providerModelOptions,
  type EngineProviderId,
} from "./engines.ts"
import { runEngineTurn } from "./engine-turn.ts"
import type {
  ProviderApprovalHandler,
  ProviderImageAttachment,
  ProviderModelOption,
  ProviderEvent,
  ProviderSelection,
  ProviderTextTurnRequest,
} from "./types.ts"

/** Upper bound for reading the Codex catalogue before a turn. */
const CATALOG_TIMEOUT_MS = 5_000

/**
 * Codex settings for workspace-write turns: writes stay inside the workspace,
 * with no network and no shared temporary directories.
 */
const WORKSPACE_WRITE_CONFIG = {
  "sandbox_workspace_write.network_access": false,
  "sandbox_workspace_write.exclude_slash_tmp": true,
  "sandbox_workspace_write.exclude_tmpdir_env_var": true,
} as const

/**
 * Claude Code settings Blitz applies to every turn: user hooks are not tools,
 * so they never act on Blitz's turns.
 */
const BLITZ_CLAUDE_SETTINGS = { disableAllHooks: true } as const

/**
 * Claude Agent SDK options Blitz applies to every turn. Hooks are off, and so
 * are the SDK's hook lifecycle events, which agent-engines turns on by default
 * from 0.4.0: Blitz shows no hook activity, so the stream stays as it was.
 */
const BLITZ_CLAUDE_SDK_OPTIONS = {
  settings: BLITZ_CLAUDE_SETTINGS,
  includeHookEvents: false,
} as const

/** Claude Code's built-in tool that carries a schema-checked reply. */
const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

/** Provider-aware text request accepted by chat and generation callers. */
export interface RunProviderTextTurnRequest {
  /** Provider integration selected for this turn. */
  readonly providerId: AiProviderId
  /** Optional local account or profile key. */
  readonly providerInstanceId?: string
  /** Provider model identifier. */
  readonly model?: string
  /** Provider-neutral reasoning level. */
  readonly effort?: string
  /** Absolute workspace used by the provider. */
  readonly workspaceDirectory: string
  /** Bounded prompt text. */
  readonly prompt: string
  /** Optional bounded native image attachments for multimodal providers. */
  readonly attachments?: readonly ProviderImageAttachment[]
  /** Application-owned instructions sent through a provider instruction channel. */
  readonly developerInstructions?: string
  /** Existing provider session to resume. */
  readonly threadId?: string
  /** Whether this turn should use a disposable session. */
  readonly ephemeral?: boolean
  /** Hosted search mode for providers that support it. */
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
  /** Sandbox policy for the selected provider. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Provider approval policy. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never" | "full-access"
  /** Caller cancellation signal. */
  readonly signal?: AbortSignal
  /** Wall-clock turn deadline. */
  readonly timeoutMs?: number
  /**
   * JSON Schema the reply must match, for background generation. Codex and
   * Claude Code enforce it and return the parsed reply as `output`; OpenCode
   * cannot, so its turns run without it and the caller parses the text as
   * before. Write it with `lib/json-schema.ts` so Codex's strict mode accepts it.
   */
  readonly outputSchema?: Record<string, unknown>
}

/** Codex settings a caller owns outright, such as the chat agent's policy and tools. */
export interface CodexTurnOverrides {
  /** Thread settings applied over Blitz's defaults; `config` entries are merged. */
  readonly thread?: CodexThreadOptions
  /** Answers the thread's `dynamicTools` calls. */
  readonly onToolCall?: CodexEngineOptions["onToolCall"]
}

/** Callbacks and test seams for one provider turn. */
export type ProviderTextTurnOptions = {
  /** Receives normalized product events. */
  readonly onEvent?: (event: CardChatEvent) => void
  /** Answers one Codex or Claude Code approval, question, or elicitation. Omission refuses it. */
  readonly onRequest?: (
    request: AgentRequest,
    providerId: EngineProviderId
  ) => Promise<void>
  /** Resolves one OpenCode tool permission. Omission denies it. */
  readonly approvalHandler?: ProviderApprovalHandler
  /** Handles verified OpenCode structured elicitation requests with native results. */
  readonly requestHandler?: AcpRequestHandler
  /** Codex thread settings and host tools owned by the caller. */
  readonly codex?: CodexTurnOverrides
  /**
   * Spending caps for a background Claude Code turn; undefined runs it
   * uncapped. Defaults to `claudeBackgroundLimits`, which caps only an
   * API-key sign-in. Tests pass a fixed answer.
   */
  readonly backgroundLimits?: () => Promise<TurnLimits | undefined>
  /** Runtime Codex catalog already read by the caller, so the turn need not read it again. */
  readonly codexModelCatalog?: readonly ProviderModelOption[]
  /** Creates the engine for a turn; tests pass a fake. */
  readonly createEngine?: (
    providerId: EngineProviderId,
    options: {
      onToolCall?: CodexEngineOptions["onToolCall"]
      effortSelected: boolean
    }
  ) => Engine
}

/** Converts OpenCode adapter events into the product event shape used by chat code. */
function productEvent(event: ProviderEvent): CardChatEvent | undefined {
  switch (event.type) {
    case "turn-started":
      return event
    case "text-delta":
      return event
    case "thought-delta":
      return event
    case "activity":
      return {
        type: "activity",
        notification: { method: event.method, params: event.params },
      }
    case "request":
      return {
        type: "activity",
        serverRequest: {
          id: event.requestId,
          method: event.method,
          params: event.params,
        },
      }
  }
}

/** Converts an OpenCode runtime error into stable Blitz recovery copy. */
function providerError(error: unknown): CardChatError {
  if (error instanceof CardChatError) return error
  const code = error instanceof AcpProviderError ? error.code : undefined
  if (code === "aborted")
    return new CardChatError("aborted", "Provider turn was interrupted", error)
  if (code === "timeout")
    return new CardChatError("timeout", "Provider turn timed out", error)
  if (code === "invalid-input")
    return new CardChatError(
      "invalid-input",
      error instanceof Error ? error.message : "Provider turn input is invalid",
      error
    )
  return new CardChatError(
    "transport",
    "The selected provider could not finish this turn",
    error
  )
}

/** Resolves after `ms`, or rejects with a transport error, for bounded catalogue reads. */
function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("The catalogue read timed out")),
        ms
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Codex thread settings for a turn: Blitz's approval policy and sandbox,
 * hosted search, and the workspace-only write rules, then the caller's
 * overrides on top.
 */
export function codexThreadOptions(
  request: RunProviderTextTurnRequest,
  overrides: CodexThreadOptions = {}
): CodexThreadOptions {
  const sandbox = request.sandbox ?? "read-only"
  const approvalPolicy =
    request.approvalPolicy === "full-access"
      ? "never"
      : (request.approvalPolicy ?? "on-request")
  const effectiveSandbox = overrides.sandbox ?? sandbox
  return {
    approvalPolicy,
    sandbox,
    ...(request.ephemeral === undefined
      ? {}
      : { ephemeral: request.ephemeral }),
    ...overrides,
    config: {
      ...(request.webSearchMode === undefined
        ? {}
        : { web_search: request.webSearchMode }),
      ...(effectiveSandbox === "workspace-write" ? WORKSPACE_WRITE_CONFIG : {}),
      ...overrides.config,
    },
  }
}

/**
 * Claude Code thread settings for a turn.
 *
 * Background generation runs fully isolated: no settings, skills, plugins,
 * hooks, MCP servers, or tools. A turn with an `outputSchema` keeps exactly
 * one tool, Claude Code's own StructuredOutput, which is how the SDK returns a
 * schema-checked reply; every other tool is still refused. Chat turns load the user's own Claude Code
 * setup (user-level settings only; project and local settings would come from
 * workspaces the agent can write to) and map Blitz's access policy onto native
 * permission modes: full access bypasses prompts, on-request routes prompts to
 * Blitz, and never or read-only deny anything that would need approval.
 */
export function claudeThreadSettings(
  request: RunProviderTextTurnRequest
): Pick<ThreadOptions, "access" | "claude"> {
  const persist = request.ephemeral ? { persistSession: false } : {}
  const background =
    request.ephemeral ||
    !request.approvalPolicy ||
    request.webSearchMode === "disabled"
  if (background)
    return {
      claude: {
        settingSources: [],
        strictMcpConfig: true,
        skills: [],
        tools: [],
        // A blanket deny would also refuse StructuredOutput; with no built-in
        // tools and no MCP servers it is the only tool left, and "dontAsk"
        // refuses anything that is not explicitly allowed.
        ...(request.outputSchema
          ? { allowedTools: [STRUCTURED_OUTPUT_TOOL] }
          : { disallowedTools: ["*"] }),
        permissionMode: "dontAsk",
        extra: {
          ...BLITZ_CLAUDE_SDK_OPTIONS,
          extraArgs: { "safe-mode": null, restricted: null },
          ...persist,
        },
      },
    }
  const claude: ClaudeThreadOptions = {
    settingSources: ["user"],
    extra: { ...BLITZ_CLAUDE_SDK_OPTIONS, ...persist },
  }
  if (request.approvalPolicy === "full-access")
    return { access: "full", claude }
  // Claude Code has no OS sandbox, so read-only also removes the write tools.
  if (request.sandbox === "read-only") return { access: "read-only", claude }
  if (request.approvalPolicy === "never")
    return { claude: { ...claude, permissionMode: "dontAsk" } }
  return { access: "ask", claude }
}

/** Creates the real engine for one turn. */
function defaultEngine(
  providerId: EngineProviderId,
  options: {
    onToolCall?: CodexEngineOptions["onToolCall"]
    effortSelected: boolean
  }
): Engine {
  return providerId === "codex"
    ? createCodexEngine(
        options.onToolCall ? { onToolCall: options.onToolCall } : {}
      )
    : createClaudeEngine({ effortSelected: options.effortSelected })
}

/** Checks the selected Codex model, effort, and image input against the runtime catalogue. */
async function checkCodexSelection(
  engine: Engine,
  selection: ProviderSelection,
  hasImages: boolean,
  catalog: readonly ProviderModelOption[] | undefined
): Promise<void> {
  let models = catalog
  if (!models) {
    try {
      models = providerModelOptions(
        await withTimeout(engine.models(), CATALOG_TIMEOUT_MS)
      )
    } catch (error) {
      throw new CardChatError(
        "transport",
        "Codex model capabilities could not be checked before this turn",
        error
      )
    }
  }
  const selectedModel =
    selection.model === "default"
      ? models.find((model) => model.isDefault)
      : models.find((model) => model.id === selection.model)
  if (selection.model !== "default" && !selectedModel)
    throw new CardChatError(
      "invalid-input",
      `Codex model is not available: ${selection.model}`
    )
  if (!selectedModel) {
    if (selection.effort || hasImages)
      throw new CardChatError(
        "invalid-input",
        "Codex default model capabilities are unavailable"
      )
    return
  }
  try {
    validateCodexModelSelection(
      models,
      {
        model: selectedModel.id,
        ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      },
      hasImages
    )
  } catch (error) {
    throw new CardChatError(
      "invalid-input",
      error instanceof Error
        ? error.message
        : "Codex model selection is invalid",
      error
    )
  }
}

/** Runs one Codex or Claude Code turn through agent-engines. */
async function runEngineProviderTurn(
  providerId: EngineProviderId,
  request: RunProviderTextTurnRequest,
  selection: ProviderSelection,
  instructions: string,
  options: ProviderTextTurnOptions
): Promise<CardChatResult> {
  let model: string | undefined
  let effort: string | undefined
  let settings: Pick<ThreadOptions, "access" | "claude" | "codex" | "limits">
  if (providerId === "claude-code") {
    if (request.approvalPolicy === "untrusted")
      throw new CardChatError(
        "invalid-input",
        "Claude Code supports on-request approvals, not Codex untrusted mode"
      )
    if (request.sandbox === "workspace-write")
      throw new CardChatError(
        "invalid-input",
        "Claude Code cannot enforce Blitz's workspace-only OS sandbox. Choose approval mode or full access."
      )
    if (selection.model.trim() && selection.model !== "default")
      model = selection.model.replace(/^claude-(sonnet|opus|haiku)$/, "$1")
    if (selection.effort && selection.effort !== "default") {
      const supported = getSupportedAiReasoningEffortsForProvider(
        "claude-code",
        selection.model
      )
      if (!supported.includes(selection.effort))
        throw new CardChatError(
          "invalid-input",
          "Claude Code reasoning level is unsupported for this model"
        )
      effort = selection.effort
    }
    settings = claudeThreadSettings(request)
    // Background work on a per-token sign-in gets Claude Code's own caps.
    // Chats and Teach are never capped, and Codex and OpenCode cannot be.
    if (request.ephemeral) {
      const limits = await (options.backgroundLimits ?? claudeBackgroundLimits)()
      if (limits) settings = { ...settings, limits }
    }
  } else {
    if (selection.model !== "default") model = selection.model
    effort = selection.effort
    settings = {
      codex: codexThreadOptions(request, options.codex?.thread),
    }
  }
  const engine = (options.createEngine ?? defaultEngine)(providerId, {
    ...(options.codex?.onToolCall
      ? { onToolCall: options.codex.onToolCall }
      : {}),
    effortSelected: effort !== undefined,
  })
  try {
    if (providerId === "codex")
      await checkCodexSelection(
        engine,
        selection,
        Boolean(request.attachments?.length),
        options.codexModelCatalog
      )
  } catch (error) {
    await engine.close().catch(() => undefined)
    throw error
  }
  return runEngineTurn(
    {
      providerId,
      engine,
      thread: {
        cwd: request.workspaceDirectory,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(instructions ? { instructions } : {}),
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
        ...settings,
      },
      ...(request.threadId ? { threadId: request.threadId } : {}),
      input: request.attachments?.length
        ? {
            text: request.prompt,
            images: request.attachments.map((attachment) => ({
              type: "base64" as const,
              mediaType: attachment.mimeType,
              data: attachment.data,
            })),
          }
        : request.prompt,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(request.timeoutMs === undefined
        ? {}
        : { timeoutMs: request.timeoutMs }),
    },
    {
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onRequest
        ? {
            onRequest: (agentRequest) =>
              options.onRequest!(agentRequest, providerId),
          }
        : {}),
    }
  )
}

/** Runs the selected provider and returns the result shape expected by Blitz features. */
export async function runProviderTextTurn(
  request: RunProviderTextTurnRequest,
  options: ProviderTextTurnOptions = {}
): Promise<CardChatResult> {
  const selection: ProviderSelection = {
    providerId: request.providerId,
    ...(request.providerInstanceId
      ? { providerInstanceId: request.providerInstanceId }
      : {}),
    model: request.model?.trim() || "default",
    ...(request.effort?.trim()
      ? { effort: request.effort.trim() as AiReasoningEffort }
      : {}),
  }
  let execution
  try {
    execution = resolveProviderExecution({
      providerId: request.providerId,
      workspaceDirectory: request.workspaceDirectory,
      sandbox: request.sandbox,
      approvalPolicy: request.approvalPolicy,
      ephemeral: request.ephemeral,
      webSearchMode: request.webSearchMode,
    })
  } catch (error) {
    throw new CardChatError(
      "invalid-input",
      error instanceof Error ? error.message : "Provider settings are invalid",
      error
    )
  }
  // Codex skills (such as PDF reading) expect the desktop app's bundled tools.
  const runtimeInstructions =
    request.providerId === "codex"
      ? await codexRuntimeInstructionsIfInstalled()
      : undefined
  const instructions = [
    request.developerInstructions?.trim(),
    providerExecutionInstructions(execution),
    runtimeInstructions,
  ]
    .filter(Boolean)
    .join("\n\n")
  if (request.providerId === "codex" || request.providerId === "claude-code")
    return runEngineProviderTurn(
      request.providerId,
      request,
      selection,
      instructions,
      options
    )

  const providerRequest: ProviderTextTurnRequest = {
    selection,
    workspaceDirectory: request.workspaceDirectory,
    prompt: request.prompt,
    ...(request.attachments?.length
      ? { attachments: request.attachments }
      : {}),
    developerInstructions: instructions,
    ...(request.threadId
      ? {
          session: {
            providerId: request.providerId,
            ...(request.providerInstanceId
              ? { providerInstanceId: request.providerInstanceId }
              : {}),
            providerSessionId: request.threadId,
          },
        }
      : {}),
    ...(request.ephemeral === undefined
      ? {}
      : { ephemeral: request.ephemeral }),
    ...(request.webSearchMode === undefined
      ? {}
      : { webSearchMode: request.webSearchMode }),
    ...(request.sandbox === undefined ? {} : { sandbox: request.sandbox }),
    ...(request.approvalPolicy === undefined
      ? {}
      : { approvalPolicy: request.approvalPolicy }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.timeoutMs === undefined
      ? {}
      : { timeoutMs: request.timeoutMs }),
  }
  try {
    const availability = await checkProviderAvailability(request.providerId, {
      workspaceDirectory: request.workspaceDirectory,
      providerInstanceId: request.providerInstanceId,
      signal: request.signal,
    })
    if (!availability.available || availability.authenticated === false)
      throw new CardChatError("transport", availability.message)
    const result = await runAcpTextTurn(providerRequest, {
      command: providerCommand(request.providerId),
      providerInstanceId:
        request.providerInstanceId ?? providerInstanceId(request.providerId),
      onEvent: (event) => {
        const normalized = productEvent(event)
        if (normalized) options.onEvent?.(normalized)
      },
      approvalHandler: options.approvalHandler,
      requestHandler: options.requestHandler,
    })
    return {
      threadId: result.threadId,
      turnId: result.turnId,
      text: result.text,
      ...(result.thought ? { thought: result.thought } : {}),
      ...(result.durationMs !== undefined
        ? { durationMs: result.durationMs }
        : {}),
    }
  } catch (error) {
    throw providerError(error)
  }
}
