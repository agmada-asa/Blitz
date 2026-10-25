/**
 * Routes one text turn through the selected provider and normalizes its events.
 *
 * Every provider runs through agent-engines: this module turns Blitz's access
 * settings into each runtime's thread options and hands the turn to
 * `engine-turn.ts`. Codex and Claude Code have their own engines; OpenCode
 * runs on the library's ACP engine (`opencode.ts`).
 */
import type {
  AgentRequest,
  ClaudeThreadOptions,
  CodexEngineOptions,
  CodexThreadOptions,
  Engine,
  ThreadOptions,
} from "agent-engines"

import {
  CardChatError,
  type CardChatEvent,
  type CardChatResult,
} from "../card-chat.ts"
import {
  getSupportedAiReasoningEffortsForProvider,
  type AiProviderId,
  type AiReasoningEffort,
} from "../../ai-model-settings.ts"
import {
  providerExecutionInstructions,
  resolveProviderExecution,
} from "../../provider-execution.ts"
import { checkProviderAvailability } from "./registry.ts"
import { validateCodexModelSelection } from "./codex-models.ts"
import { codexRuntimeInstructionsIfInstalled } from "./codex-runtime.ts"
import {
  createClaudeEngine,
  createCodexEngine,
  providerModelOptions,
  type EngineProviderId,
} from "./engines.ts"
import { runEngineTurn, type TurnProviderId } from "./engine-turn.ts"
import {
  createOpenCodeEngine,
  openCodeAccess,
  openCodePrompt,
  type OpenCodeSpawn,
} from "./opencode.ts"
import type {
  ProviderImageAttachment,
  ProviderModelOption,
  ProviderSelection,
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
  /** Answers one approval, question, or elicitation from any provider. Omission refuses it. */
  readonly onRequest?: (
    request: AgentRequest,
    providerId: TurnProviderId
  ) => Promise<void>
  /** Codex thread settings and host tools owned by the caller. */
  readonly codex?: CodexTurnOverrides
  /** Runtime Codex catalog already read by the caller, so the turn need not read it again. */
  readonly codexModelCatalog?: readonly ProviderModelOption[]
  /** Starts the OpenCode process for a turn; tests pass a fake ACP peer. */
  readonly spawnOpenCode?: OpenCodeSpawn
  /** Creates the Codex or Claude Code engine for a turn; tests pass a fake. */
  readonly createEngine?: (
    providerId: EngineProviderId,
    options: {
      onToolCall?: CodexEngineOptions["onToolCall"]
      effortSelected: boolean
    }
  ) => Engine
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
 * hooks, MCP servers, or tools. Chat turns load the user's own Claude Code
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
        disallowedTools: ["*"],
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

/**
 * Checks that the installed OpenCode is a supported, signed-in release before
 * its turn starts, since its ACP engine only finds out once a session opens.
 */
async function checkOpenCodeReady(
  request: RunProviderTextTurnRequest
): Promise<void> {
  const availability = await checkProviderAvailability("opencode", {
    workspaceDirectory: request.workspaceDirectory,
    providerInstanceId: request.providerInstanceId,
    signal: request.signal,
  })
  if (!availability.available || availability.authenticated === false)
    throw new CardChatError("transport", availability.message)
}

/** Runs one turn of any provider through agent-engines. */
async function runEngineProviderTurn(
  providerId: TurnProviderId,
  request: RunProviderTextTurnRequest,
  selection: ProviderSelection,
  instructions: string,
  options: ProviderTextTurnOptions
): Promise<CardChatResult> {
  let model: string | undefined
  let effort: string | undefined
  let settings: Pick<ThreadOptions, "access" | "claude" | "codex" | "mode">
  let prompt = request.prompt
  if (providerId === "opencode") {
    if (request.sandbox === "workspace-write")
      throw new CardChatError(
        "invalid-input",
        "This provider cannot enforce a workspace-only OS sandbox. Choose approval mode or full access."
      )
    if (selection.model.trim() && selection.model !== "default")
      model = selection.model
    if (selection.effort && selection.effort !== "default")
      throw new CardChatError(
        "invalid-input",
        "OpenCode reasoning level is unsupported for this model"
      )
    prompt = openCodePrompt(request.prompt, instructions)
    // `default` reasserts the session's own mode: the Blitz agent this turn defines.
    settings = { access: openCodeAccess(request), mode: "default" }
  } else if (providerId === "claude-code") {
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
  } else {
    if (selection.model !== "default") model = selection.model
    effort = selection.effort
    settings = {
      codex: codexThreadOptions(request, options.codex?.thread),
    }
  }
  // A fake OpenCode peer in tests stands in for the installed CLI as well.
  if (providerId === "opencode" && !options.spawnOpenCode)
    await checkOpenCodeReady(request)
  const engine =
    providerId === "opencode"
      ? createOpenCodeEngine(
          request,
          request.workspaceDirectory,
          options.spawnOpenCode
        )
      : (options.createEngine ?? defaultEngine)(providerId, {
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
        // OpenCode has no instruction channel; its prompt carries them instead.
        ...(instructions && providerId !== "opencode" ? { instructions } : {}),
        ...settings,
      },
      ...(request.threadId ? { threadId: request.threadId } : {}),
      ...(providerId === "opencode" ? { confirmResume: true } : {}),
      input: request.attachments?.length
        ? {
            text: prompt,
            images: request.attachments.map((attachment) => ({
              type: "base64" as const,
              mediaType: attachment.mimeType,
              data: attachment.data,
            })),
          }
        : prompt,
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
  return runEngineProviderTurn(
    request.providerId,
    request,
    selection,
    instructions,
    options
  )
}
