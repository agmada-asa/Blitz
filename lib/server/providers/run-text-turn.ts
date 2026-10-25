/**
 * Routes one text turn through the selected provider and normalizes its events.
 *
 * Every provider runs through agent-engines: this module turns Blitz's access
 * settings into each runtime's thread options and hands the turn to
 * `engine-turn.ts`. Codex and Claude Code have their own engines; OpenCode
 * runs on the library's ACP engine (`opencode.ts`).
 *
 * The same thread settings also prewarm an engine before a Teach session's
 * first turn (`prewarmProviderTextTurn`, claimed from `engine-pool.ts`) and
 * compact a saved thread on request (`compactProviderThread`), so neither can
 * drift from what a real turn sends. Neither applies to OpenCode, whose ACP
 * engine cannot prewarm or compact.
 */
import type {
  AgentRequest,
  ClaudeThreadOptions,
  CodexEngineOptions,
  CodexThreadOptions,
  Engine,
  PortableTranscript,
  ThreadOptions,
  TurnInput,
  TurnLimits,
} from "agent-engines"

import {
  CardChatError,
  type CardChatEvent,
  type CardChatResult,
} from "../card-chat.ts"
import { claudeBackgroundLimits } from "../spending-limits.ts"
import { providerThreadFeatures } from "../../provider-thread-features.ts"
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
import {
  runEngineCompaction,
  runEngineTurn,
  type EngineCompactionResult,
  type TurnProviderId,
} from "./engine-turn.ts"
import {
  claimPrewarmedEngine,
  offerPrewarmedEngine,
  prewarmedEngineKey,
  withdrawPrewarmedEngine,
  type ToolCallHandler,
} from "./engine-pool.ts"
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
  /**
   * Files the model reads as documents, by absolute path. Claude Code sends
   * PDFs and text files as document content; Codex is told their paths.
   * OpenCode turns ignore them, so callers only pass files to a provider that
   * reads them and keep the extracted text for the others.
   */
  readonly files?: readonly { path: string; name?: string; mediaType?: string }[]
  /** Application-owned instructions sent through a provider instruction channel. */
  readonly developerInstructions?: string
  /** Existing provider session to resume. */
  readonly threadId?: string
  /**
   * Saved Codex or Claude Code session to copy into a new one instead of
   * resuming `threadId`, through `throughTurnId` when given. OpenCode ignores it.
   */
  readonly fork?: { readonly threadId: string; readonly throughTurnId?: string }
  /** Compacts the Codex or Claude Code thread before the turn. OpenCode ignores it. */
  readonly compactFirst?: boolean
  /** Prompt sent instead of `prompt` when `compactFirst` compacted the thread. */
  readonly compactedPrompt?: string
  /**
   * Drops this Codex or Claude Code turn and the ones after it before the new
   * turn runs, so a reply is redone in place. OpenCode ignores it.
   */
  readonly rewindBeforeTurnId?: string
  /** Reports Codex or Claude Code context usage on the result. OpenCode ignores it. */
  readonly readContextUsage?: boolean
  /**
   * Conversation from another provider's session, carried into a new session.
   * Ignored when resuming or forking, since the session already holds its history.
   */
  readonly seed?: PortableTranscript
  /** Whether this turn should use a disposable session. */
  readonly ephemeral?: boolean
  /** Hosted search mode for providers that support it. */
  readonly webSearchMode?: "cached" | "indexed" | "live" | "disabled"
  /** Sandbox policy for the selected provider. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  /** Provider approval policy. */
  readonly approvalPolicy?: "untrusted" | "on-request" | "never" | "full-access"
  /**
   * `plan` proposes a plan for approval before changing anything (Codex and
   * Claude Code). Once it is approved the agent carries it out, with edits
   * allowed where the access level would otherwise ask about each one.
   * OpenCode turns ignore it.
   */
  readonly mode?: "plan"
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
  /** Answers one approval, question, or elicitation from any provider. Omission refuses it. */
  readonly onRequest?: (
    request: AgentRequest,
    providerId: TurnProviderId
  ) => Promise<void>
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

/** Thread settings for one turn, before an engine exists. */
type EngineThreadSetup = {
  /** Thread options the turn starts or resumes with. */
  readonly thread: ThreadOptions
  /** Whether an effort is set, which changes the Claude Code launch environment. */
  readonly effortSelected: boolean
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

/**
 * Builds the thread options for a turn from Blitz's selection and access
 * settings.
 *
 * @throws CardChatError for a policy or effort the provider cannot honour.
 */
async function engineThreadSetup(
  providerId: TurnProviderId,
  request: RunProviderTextTurnRequest,
  selection: ProviderSelection,
  instructions: string,
  options: Pick<ProviderTextTurnOptions, "backgroundLimits" | "codex">
): Promise<EngineThreadSetup> {
  let model: string | undefined
  let effort: string | undefined
  let settings: Pick<
    ThreadOptions,
    "access" | "claude" | "codex" | "limits" | "mode"
  >
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
    // An approved plan is the learner's go-ahead for its edits, so the turn
    // continues with edits allowed instead of asking about each one.
    if (request.mode === "plan" && settings.access === "ask")
      settings = { ...settings, access: "accept-edits" }
    // Background work on a per-token sign-in gets Claude Code's own caps.
    // Chats and Teach are never capped, and Codex and OpenCode cannot be.
    if (request.ephemeral && providerThreadFeatures(providerId).spendingCaps) {
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
  return {
    thread: {
      cwd: request.workspaceDirectory,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      // OpenCode has no instruction channel; its prompt carries them instead.
      ...(instructions && providerId !== "opencode" ? { instructions } : {}),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      ...settings,
      // A resumed or copied session already holds its own history.
      ...(request.seed && !request.threadId && !request.fork
        ? { seed: request.seed }
        : {}),
    },
    effortSelected: effort !== undefined,
  }
}

/**
 * Creates a Codex engine whose host tool handler can be pointed at a turn
 * later, so a prewarmed engine serves whichever turn claims it.
 */
function rebindableCodexEngine(): {
  engine: Engine
  bindToolCalls: (handler: ToolCallHandler | undefined) => void
} {
  let current: ToolCallHandler | undefined
  const engine = createCodexEngine({
    onToolCall: (call) =>
      current
        ? current(call)
        : Promise.resolve({ text: "This tool is not available.", success: false }),
  })
  return { engine, bindToolCalls: (handler) => void (current = handler) }
}

/**
 * Takes a prewarmed engine for this turn when one is waiting. Claude Code's
 * prewarm opens a new thread's process, so only a new thread claims it;
 * Codex's starts the app-server, which any of its turns can use. Tests that
 * pass their own engine factory never use the pool.
 */
function claimEngine(
  providerId: EngineProviderId,
  request: RunProviderTextTurnRequest,
  setup: EngineThreadSetup,
  options: ProviderTextTurnOptions
): Engine | undefined {
  if (options.createEngine) return undefined
  if (providerId === "claude-code" && (request.threadId || request.fork))
    return undefined
  const pooled = claimPrewarmedEngine(
    prewarmedEngineKey(providerId, request.workspaceDirectory, setup.effortSelected)
  )
  pooled?.bindToolCalls?.(options.codex?.onToolCall)
  return pooled?.engine
}

/**
 * Builds a turn's input from its text and the request's images and files.
 * Plain text when there is neither, so a text-only turn stays a string.
 */
function turnInput(text: string, request: RunProviderTextTurnRequest): TurnInput {
  if (!request.attachments?.length && !request.files?.length) return text
  return {
    text,
    ...(request.attachments?.length
      ? {
          images: request.attachments.map((attachment) => ({
            type: "base64" as const,
            mediaType: attachment.mimeType,
            data: attachment.data,
          })),
        }
      : {}),
    ...(request.files?.length
      ? {
          files: request.files.map((file) => ({
            type: "path" as const,
            ...file,
          })),
        }
      : {}),
  }
}

/**
 * Leaves out the options a provider's runtime does not support, as
 * `lib/provider-thread-features.ts` lists them, so a turn never sends one.
 * The engines throw `UnsupportedFeatureError` for an unsupported option rather
 * than dropping it, and callers such as background generation pass the same
 * request to every provider: OpenCode's ACP engine gets no reply schema, plan
 * mode, files, fork, compaction, rewind, or context usage read, and its text is
 * parsed as before.
 *
 * @param request - The turn as the caller asked for it.
 * @returns The same turn without the unsupported options.
 */
export function supportedTurnRequest<T extends Omit<RunProviderTextTurnRequest, "prompt">>(
  request: T
): T {
  const features = providerThreadFeatures(request.providerId)
  const {
    outputSchema,
    mode,
    files,
    fork,
    compactFirst,
    compactedPrompt,
    rewindBeforeTurnId,
    readContextUsage,
    ...rest
  } = request
  return {
    ...rest,
    ...(outputSchema && features.outputSchema ? { outputSchema } : {}),
    ...(mode && features.planMode ? { mode } : {}),
    ...(files?.length && features.documents ? { files } : {}),
    ...(fork && features.fork ? { fork } : {}),
    ...(compactFirst && features.compact
      ? { compactFirst, ...(compactedPrompt ? { compactedPrompt } : {}) }
      : {}),
    ...(rewindBeforeTurnId && features.rewind ? { rewindBeforeTurnId } : {}),
    ...(readContextUsage && features.contextUsage ? { readContextUsage } : {}),
  } as T
}

/** Runs one turn of any provider through agent-engines. */
async function runEngineProviderTurn(
  providerId: TurnProviderId,
  requested: RunProviderTextTurnRequest,
  selection: ProviderSelection,
  instructions: string,
  options: ProviderTextTurnOptions
): Promise<CardChatResult> {
  const request = supportedTurnRequest(requested)
  const setup = await engineThreadSetup(
    providerId,
    request,
    selection,
    instructions,
    options
  )
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
      : (claimEngine(providerId, request, setup, options) ??
        (options.createEngine ?? defaultEngine)(providerId, {
          ...(options.codex?.onToolCall
            ? { onToolCall: options.codex.onToolCall }
            : {}),
          effortSelected: setup.effortSelected,
        }))
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
      thread: setup.thread,
      ...(request.threadId ? { threadId: request.threadId } : {}),
      // An ACP agent reports a turn as started before it checks a reloaded session.
      ...(providerId === "opencode" ? { confirmResume: true } : {}),
      ...(request.fork ? { fork: request.fork } : {}),
      ...(request.mode ? { turnOptions: { mode: request.mode } } : {}),
      ...(request.compactFirst ? { compactFirst: true } : {}),
      ...(request.compactFirst && request.compactedPrompt
        ? { compactedInput: turnInput(request.compactedPrompt, request) }
        : {}),
      ...(request.rewindBeforeTurnId
        ? { rewindBeforeTurnId: request.rewindBeforeTurnId }
        : {}),
      ...(request.readContextUsage ? { readContextUsage: true } : {}),
      input: turnInput(
        // OpenCode has no instruction channel, so its prompt carries them.
        providerId === "opencode"
          ? openCodePrompt(request.prompt, instructions)
          : request.prompt,
        request
      ),
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

/**
 * Resolves a turn's provider selection and the instructions it sends: the
 * caller's, the execution policy's, and Codex's runtime notes.
 *
 * @throws CardChatError when the execution settings are invalid.
 */
async function turnBasics(
  request: RunProviderTextTurnRequest
): Promise<{ selection: ProviderSelection; instructions: string }> {
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
  return { selection, instructions }
}

/**
 * Starts the runtime for a turn that has not been sent yet, and leaves the
 * engine in the pool for that turn to claim. On Claude Code it also opens the
 * new thread's process with the exact options the turn will use. Only new
 * Codex or Claude Code threads are worth prewarming; anything else is a no-op.
 *
 * @param request - The turn as it will be sent, minus its prompt.
 * @returns Whether an engine was offered. Never throws.
 */
export async function prewarmProviderTextTurn(
  request: Omit<RunProviderTextTurnRequest, "prompt">
): Promise<boolean> {
  if (
    (request.providerId !== "codex" && request.providerId !== "claude-code") ||
    !providerThreadFeatures(request.providerId).prewarm
  )
    return false
  if (request.threadId) return false
  const providerId = request.providerId
  let key: string | undefined
  let engine: Engine | undefined
  try {
    const turn = supportedTurnRequest({ ...request, prompt: "" })
    const { selection, instructions } = await turnBasics(turn)
    const setup = await engineThreadSetup(providerId, turn, selection, instructions, {})
    key = prewarmedEngineKey(providerId, request.workspaceDirectory, setup.effortSelected)
    let bindToolCalls: ((handler: ToolCallHandler | undefined) => void) | undefined
    if (providerId === "codex") {
      const codex = rebindableCodexEngine()
      engine = codex.engine
      bindToolCalls = codex.bindToolCalls
    } else engine = createClaudeEngine({ effortSelected: setup.effortSelected })
    // Offered before it is ready, so a turn arriving meanwhile still claims it.
    offerPrewarmedEngine(key, engine, bindToolCalls)
    await engine.prewarm(providerId === "claude-code" ? setup.thread : undefined)
    return true
  } catch (error) {
    if (key && engine) withdrawPrewarmedEngine(key, engine)
    console.warn("Provider could not be prewarmed", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return false
  }
}

/**
 * Compacts a saved Codex or Claude Code thread outside a turn, with the same
 * thread settings its turns use, and reads its context usage afterwards.
 *
 * @param request - The thread's turn settings; `threadId` names the thread.
 * @param options.createEngine - Test seam for the engine.
 * @returns Whether it compacted. Never throws.
 */
export async function compactProviderThread(
  request: Omit<RunProviderTextTurnRequest, "prompt"> & { threadId: string },
  options: Pick<ProviderTextTurnOptions, "createEngine"> = {}
): Promise<EngineCompactionResult> {
  if (
    (request.providerId !== "codex" && request.providerId !== "claude-code") ||
    !providerThreadFeatures(request.providerId).compact
  )
    return { compacted: false }
  const providerId = request.providerId
  try {
    const turn = supportedTurnRequest({ ...request, prompt: "" })
    const { selection, instructions } = await turnBasics(turn)
    const setup = await engineThreadSetup(providerId, turn, selection, instructions, {})
    const engine = (options.createEngine ?? defaultEngine)(providerId, {
      effortSelected: setup.effortSelected,
    })
    return await runEngineCompaction({
      engine,
      thread: setup.thread,
      threadId: request.threadId,
      timeoutMs: request.timeoutMs ?? 5 * 60_000,
    })
  } catch (error) {
    console.warn("Provider thread could not be compacted", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return { compacted: false }
  }
}

/** Runs the selected provider and returns the result shape expected by Blitz features. */
export async function runProviderTextTurn(
  request: RunProviderTextTurnRequest,
  options: ProviderTextTurnOptions = {}
): Promise<CardChatResult> {
  const { selection, instructions } = await turnBasics(request)
  return runEngineProviderTurn(
    request.providerId,
    request,
    selection,
    instructions,
    options
  )
}
