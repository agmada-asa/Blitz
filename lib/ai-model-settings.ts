/** Defines task-specific provider, model, and reasoning settings shared by Blitz. */

/** Provider integrations Blitz can route local AI work through. */
export const AI_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "opencode",
  "antigravity",
] as const

/** Stable identifier for one local provider integration. */
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number]

/** Approval modes that the local adapters can enforce. `never` denies approval requests; it does not bypass checks. */
export type AiApprovalPolicy =
  "untrusted" | "on-request" | "never" | "full-access"

/** Per-provider native access choices. Full access applies only to interactive chat. */
export const AI_PROVIDER_APPROVAL_POLICIES: Readonly<
  Record<AiProviderId, readonly AiApprovalPolicy[]>
> = {
  codex: ["untrusted", "on-request", "never", "full-access"],
  "claude-code": ["never", "on-request", "full-access"],
  opencode: ["never", "on-request", "full-access"],
  antigravity: ["never", "on-request", "full-access"],
}

/** Validates persisted policies and fills legacy records with conservative defaults. */
export function validateProviderApprovalPolicies(
  policies: Partial<Record<AiProviderId, string>> = {}
): Record<AiProviderId, AiApprovalPolicy> {
  const result = {} as Record<AiProviderId, AiApprovalPolicy>
  for (const provider of AI_PROVIDER_IDS) {
    const policy =
      policies[provider] ?? AI_PROVIDER_APPROVAL_POLICIES[provider][0]
    if (
      !AI_PROVIDER_APPROVAL_POLICIES[provider].includes(
        policy as AiApprovalPolicy
      )
    )
      throw new Error(`Approval policy is not supported by ${provider}`)
    result[provider] = policy as AiApprovalPolicy
  }
  return result
}

/** Resolves the provider policy for interactive chat; background jobs always deny approvals. */
export function resolveProviderApprovalPolicy(
  settings: AiModelSettings | null | undefined,
  provider: AiProviderId
): AiApprovalPolicy {
  return validateProviderApprovalPolicies(settings?.providerApprovalPolicies)[
    provider
  ]
}

/** Labels and setup guidance shown when a provider is selected in settings. */
export type AiProviderOption = {
  readonly id: AiProviderId
  readonly label: string
  readonly description: string
}

/** Provider choices shown in the shared settings and chat pickers. */
export const AI_PROVIDER_OPTIONS: readonly AiProviderOption[] = [
  {
    id: "codex",
    label: "Codex",
    description: "Blitz's built-in local assistant runtime.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Use a local Claude Code installation.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Use a local OpenCode ACP installation.",
  },
  {
    id: "antigravity",
    label: "Antigravity",
    description: "Use a managed or configured Antigravity ACP runtime.",
  },
]

/** Names the task-specific provider field stored beside the legacy model fields. */
export const AI_PROVIDER_FIELDS = [
  "researchProvider",
  "replyProvider",
  "cardGenerationProvider",
] as const

/** A field that selects one provider for one kind of AI work. */
export type AiProviderField = (typeof AI_PROVIDER_FIELDS)[number]

/** Stable task names used by server-side provider routing. */
export type AiTask = "research" | "reply" | "cardGeneration"

/** Maps a task to its persisted provider field. */
export const AI_TASK_PROVIDER_FIELDS: Readonly<
  Record<AiTask, AiProviderField>
> = {
  research: "researchProvider",
  reply: "replyProvider",
  cardGeneration: "cardGenerationProvider",
}

/** Provider tasks that have passed the current capability review in Blitz. */
export const AI_PROVIDER_TASKS: Readonly<
  Record<AiProviderId, readonly AiTask[]>
> = {
  codex: ["research", "reply", "cardGeneration"],
  "claude-code": ["reply", "cardGeneration"],
  opencode: ["reply", "cardGeneration"],
  antigravity: ["reply"],
}

/** Names the persisted model field used for each kind of AI work. */
export const AI_MODEL_FIELDS = [
  "researchModel",
  "replyModel",
  "cardGenerationModel",
] as const

/** Names the persisted reasoning field used for each kind of AI work. */
export const AI_REASONING_FIELDS = [
  "researchEffort",
  "replyEffort",
  "cardGenerationEffort",
] as const

/** A field name that selects one configured AI model. */
export type AiModelField = (typeof AI_MODEL_FIELDS)[number]

/** A field name that selects one configured AI reasoning level. */
export type AiReasoningField = (typeof AI_REASONING_FIELDS)[number]

/** The reasoning levels offered by the installed Codex model picker. */
export const AI_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const

/** A supported reasoning level, or an explicit provider default when no control exists. */
export type AiReasoningEffort =
  (typeof AI_REASONING_EFFORTS)[number] | "default"

/** One curated Codex model and the reasoning levels it supports in Blitz. */
export type CodexModelOption = {
  readonly id: string
  readonly label: string
  readonly reasoningEfforts: readonly AiReasoningEffort[]
}

/** One generation grouping of Codex models separated by menu dividers. */
export type CodexModelGroup = {
  /** The generation identifier, such as "GPT-6", "GPT-5.6", or "OTHER". */
  readonly generation: string
  /** Models belonging to this generation. */
  readonly options: readonly CodexModelOption[]
}

/** Model choices exposed by Blitz's local Codex setup. */
export const CODEX_MODEL_OPTIONS = [
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
  },
] as const satisfies readonly CodexModelOption[]

/** A model identifier included in Blitz's curated picker. */
export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]["id"]

/** One curated model choice for a non-Codex provider. */
export type AiProviderModelOption = {
  readonly id: string
  readonly label: string
  readonly reasoningEfforts: readonly AiReasoningEffort[]
}

/** Curated defaults used until a provider reports a runtime model catalog. */
export const AI_PROVIDER_MODEL_OPTIONS: Readonly<
  Record<Exclude<AiProviderId, "codex">, readonly AiProviderModelOption[]>
> = {
  "claude-code": [
    {
      id: "sonnet",
      label: "Claude Sonnet",
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "opus",
      label: "Claude Opus",
      reasoningEfforts: ["medium", "high", "xhigh"],
    },
    {
      id: "haiku",
      label: "Claude Haiku",
      reasoningEfforts: ["default"],
    },
  ],
  opencode: [
    {
      id: "opencode/big-pickle",
      label: "OpenCode Big Pickle",
      reasoningEfforts: ["default"],
    },
  ],
  antigravity: [
    {
      id: "antigravity/default",
      label: "Antigravity default",
      reasoningEfforts: ["default"],
    },
  ],
}

/** Untrusted model and reasoning strings accepted at the persistence boundary. */
export type AiModelSettingsInput = Record<AiModelField, string> &
  Record<AiReasoningField, string> &
  Partial<Record<AiProviderField, string>> & {
    providerApprovalPolicies?: Partial<Record<AiProviderId, string>>
  }

/** One validated model and reasoning selection for every AI task Blitz runs. */
export type AiModelSettings = Record<AiModelField, string> &
  Record<AiReasoningField, AiReasoningEffort> &
  Partial<Record<AiProviderField, AiProviderId>> & {
    providerApprovalPolicies?: Partial<Record<AiProviderId, AiApprovalPolicy>>
  }

/** Model used by each task before a setting or legacy environment fallback exists. */
export const DEFAULT_AI_MODELS: Readonly<Record<AiModelField, string>> = {
  researchModel: "gpt-5.6-luna",
  replyModel: "gpt-5.6-luna",
  cardGenerationModel: "gpt-5.6-luna",
}

/** Reasoning level used by each task before a setting or legacy fallback exists. */
export const DEFAULT_AI_REASONING_EFFORTS: Readonly<
  Record<AiReasoningField, AiReasoningEffort>
> = {
  researchEffort: "medium",
  replyEffort: "low",
  cardGenerationEffort: "medium",
}

/** Complete default configuration used until the first settings record is saved. */
export const DEFAULT_AI_MODEL_SETTINGS: Readonly<AiModelSettings> = {
  providerApprovalPolicies: validateProviderApprovalPolicies(),
  ...DEFAULT_AI_MODELS,
  ...DEFAULT_AI_REASONING_EFFORTS,
  researchProvider: "codex",
  replyProvider: "codex",
  cardGenerationProvider: "codex",
}

/** Keeps persisted model IDs bounded before they reach the local Codex bridge. */
export const MAX_AI_MODEL_NAME_LENGTH = 120

/** Labels model settings in validation messages without leaking implementation field names. */
const AI_MODEL_FIELD_LABELS: Record<AiModelField, string> = {
  researchModel: "Research",
  replyModel: "Reply",
  cardGenerationModel: "Card generation",
}

/** Labels reasoning settings in validation messages without leaking implementation field names. */
const AI_REASONING_FIELD_LABELS: Record<AiReasoningField, string> = {
  researchEffort: "Research",
  replyEffort: "Reply",
  cardGenerationEffort: "Card generation",
}

/** Labels provider fields in validation messages without exposing schema names. */
const AI_PROVIDER_FIELD_LABELS: Record<AiProviderField, string> = {
  researchProvider: "Research",
  replyProvider: "Reply",
  cardGenerationProvider: "Card generation",
}

/** Looks up curated model capabilities without constraining previously saved custom model IDs. */
const MODEL_OPTION_BY_ID = new Map<string, CodexModelOption>(
  CODEX_MODEL_OPTIONS.map((option) => [option.id, option])
)

/** Accepts the punctuation used by Codex model IDs while rejecting whitespace and control text. */
const AI_MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/@-]+$/

/** Returns whether a model ID is included in the current picker. */
export function isKnownCodexModel(model: string): model is CodexModelId {
  return MODEL_OPTION_BY_ID.has(model)
}

/** Returns whether an identifier belongs to the supported provider set. */
export function isAiProviderId(
  value: string | undefined
): value is AiProviderId {
  return AI_PROVIDER_IDS.includes(value as AiProviderId)
}

/** Returns the visible provider choices in their stable settings order. */
export function getAiProviderOptions(): readonly AiProviderOption[] {
  return AI_PROVIDER_OPTIONS
}

/** Returns providers currently reviewed for one task's capability requirements. */
export function getAiProviderOptionsForTask(
  task: AiTask
): readonly AiProviderOption[] {
  return AI_PROVIDER_OPTIONS.filter((option) =>
    AI_PROVIDER_TASKS[option.id].includes(task)
  )
}

/** Returns the provider's curated model choices while preserving saved custom IDs. */
export function getAiModelPickerOptions(
  provider: AiProviderId,
  model: string
): readonly AiProviderModelOption[] {
  if (provider === "codex") return getCodexModelPickerOptions(model)
  const options = AI_PROVIDER_MODEL_OPTIONS[provider]
  if (!model || !model.trim() || options.some((option) => option.id === model))
    return options
  return [
    {
      id: model,
      label: `${model} (saved model)`,
      reasoningEfforts: ["default"],
    },
    ...options,
  ]
}

/** Returns the curated default model for a provider when a task changes providers. */
export function getDefaultAiModelOption(
  provider: AiProviderId
): AiProviderModelOption {
  const option =
    provider === "codex"
      ? CODEX_MODEL_OPTIONS.find(
          (candidate) => candidate.id === DEFAULT_AI_MODELS.replyModel
        )
      : AI_PROVIDER_MODEL_OPTIONS[provider][0]
  if (!option) throw new Error(`Provider ${provider} has no model options`)
  return option
}

/** Returns curated model choices while preserving one previously saved legacy model as selectable. */
export function getCodexModelPickerOptions(
  model: string
): readonly CodexModelOption[] {
  if (!model || !model.trim() || isKnownCodexModel(model))
    return CODEX_MODEL_OPTIONS
  return [
    {
      id: model,
      label: `${model} (saved model)`,
      reasoningEfforts: AI_REASONING_EFFORTS,
    },
    ...CODEX_MODEL_OPTIONS,
  ]
}

/** Returns the reasoning levels supported by a selected model or the generic picker set for legacy models. */
export function getSupportedAiReasoningEfforts(
  model: string
): readonly AiReasoningEffort[] {
  return MODEL_OPTION_BY_ID.get(model)?.reasoningEfforts ?? AI_REASONING_EFFORTS
}

/** Returns reasoning levels supported by a selected provider and model. */
export function getSupportedAiReasoningEffortsForProvider(
  provider: AiProviderId,
  model: string
): readonly AiReasoningEffort[] {
  if (provider === "opencode" || provider === "antigravity") return ["default"]
  const normalizedModel =
    provider === "claude-code"
      ? model.replace(/^claude-(sonnet|opus|haiku)$/, "$1")
      : model
  return (
    getAiModelPickerOptions(provider, normalizedModel).find(
      (option) => option.id === normalizedModel
    )?.reasoningEfforts ?? AI_REASONING_EFFORTS
  )
}

/** Validates one persisted provider field and defaults older records to Codex. */
export function validateAiProviderId(
  value: string | undefined,
  field: AiProviderField
): AiProviderId {
  const provider = value?.trim() || "codex"
  if (!isAiProviderId(provider))
    throw new Error(
      `${AI_PROVIDER_FIELD_LABELS[field]} provider is not supported`
    )
  return provider
}

/**
 * Groups model choices so menu dividers appear between distinct model generations.
 *
 * Distinguishes major and minor GPT release generations (e.g. GPT-6, GPT-5.6, GPT-5.5,
 * GPT-5.4, GPT-5.3) while grouping variant models of the same generation (such as
 * Sol, Terra, and Luna) together. Unrecognized labels fall into an "OTHER" group.
 *
 * @param options - The list of model options to partition into generations.
 * @returns An array of generation groups in the order their models first appeared.
 */
export function groupCodexModelOptions(
  options: readonly CodexModelOption[]
): readonly CodexModelGroup[] {
  const grouped = new Map<string, CodexModelOption[]>()
  for (const option of options) {
    // Matches major and minor model generations such as GPT-6, GPT-5.6, GPT-5.5, GPT-5.4, or GPT-5.3.
    const generation =
      option.label.match(/^GPT-\d+(?:\.\d+)?/i)?.[0]?.toUpperCase() ?? "OTHER"
    const group = grouped.get(generation)
    if (group) {
      group.push(option)
    } else {
      grouped.set(generation, [option])
    }
  }
  return Array.from(grouped, ([generation, groupedOptions]) => ({
    generation,
    options: groupedOptions,
  }))
}

/** Validates and normalizes one user-supplied Codex model ID. */
export function validateAiModelName(
  value: string,
  field: AiModelField
): string {
  const model = value.trim()
  const label = AI_MODEL_FIELD_LABELS[field]
  if (!model) throw new Error(`${label} model is required`)
  if (model.length > MAX_AI_MODEL_NAME_LENGTH)
    throw new Error(
      `${label} model must be at most ${MAX_AI_MODEL_NAME_LENGTH} characters`
    )
  if (!AI_MODEL_NAME_PATTERN.test(model))
    throw new Error(`${label} model contains unsupported characters`)
  return model
}

/** Validates a selected reasoning level against its paired model when Blitz knows that model. */
export function validateAiReasoningEffort(
  value: string,
  model: string,
  field: AiReasoningField,
  provider?: AiProviderId
): AiReasoningEffort {
  const effort = value.trim() as AiReasoningEffort
  const label = AI_REASONING_FIELD_LABELS[field]
  if (
    effort !== "default" &&
    !(AI_REASONING_EFFORTS as readonly string[]).includes(effort)
  )
    throw new Error(`${label} reasoning level is not supported`)
  const supportedEfforts = provider
    ? getSupportedAiReasoningEffortsForProvider(provider, model)
    : getSupportedAiReasoningEfforts(model)
  // Older records offered effort choices for adapters/models with no such control.
  // Normalize those records to an explicit default so they stay editable.
  if (supportedEfforts.length === 1 && supportedEfforts[0] === "default")
    return "default"
  if (!supportedEfforts.includes(effort)) {
    throw new Error(`${label} reasoning level is not available for ${model}`)
  }
  return effort
}

/** Validates all task selections before they are saved or handed to a worker. */
export function validateAiModelSettings(
  settings: AiModelSettingsInput
): AiModelSettings {
  const researchModel = validateAiModelName(
    settings.researchModel,
    "researchModel"
  )
  const replyModel = validateAiModelName(settings.replyModel, "replyModel")
  const cardGenerationModel = validateAiModelName(
    settings.cardGenerationModel,
    "cardGenerationModel"
  )
  const researchProvider = validateAiProviderId(
    settings.researchProvider,
    "researchProvider"
  )
  const replyProvider = validateAiProviderId(
    settings.replyProvider,
    "replyProvider"
  )
  const cardGenerationProvider = validateAiProviderId(
    settings.cardGenerationProvider,
    "cardGenerationProvider"
  )
  if (!AI_PROVIDER_TASKS[researchProvider].includes("research"))
    throw new Error(
      "Research requires a provider with an approved web-search capability"
    )
  return {
    providerApprovalPolicies: validateProviderApprovalPolicies(
      settings.providerApprovalPolicies
    ),
    researchModel,
    replyModel,
    cardGenerationModel,
    researchProvider,
    replyProvider,
    cardGenerationProvider,
    researchEffort: validateAiReasoningEffort(
      settings.researchEffort,
      researchModel,
      "researchEffort",
      researchProvider
    ),
    replyEffort: validateAiReasoningEffort(
      settings.replyEffort,
      replyModel,
      "replyEffort",
      replyProvider
    ),
    cardGenerationEffort: validateAiReasoningEffort(
      settings.cardGenerationEffort,
      cardGenerationModel,
      "cardGenerationEffort",
      cardGenerationProvider
    ),
  }
}

/** Resolves a saved model first, then the legacy worker fallback, then Blitz's default. */
export function resolveAiModel(
  settings: AiModelSettings | null | undefined,
  field: AiModelField,
  environmentFallback?: string
): string {
  if (settings) return settings[field]
  const fallback = environmentFallback?.trim()
  return fallback || DEFAULT_AI_MODELS[field]
}

/** Resolves saved reasoning first, then the legacy worker fallback, then Blitz's default. */
export function resolveAiReasoningEffort(
  settings: AiModelSettings | null | undefined,
  field: AiReasoningField,
  environmentFallback?: string
): string {
  if (settings) return settings[field]
  const fallback = environmentFallback?.trim()
  return fallback || DEFAULT_AI_REASONING_EFFORTS[field]
}

/** Resolves a saved provider first, then the Codex compatibility default. */
export function resolveAiProvider(
  settings: AiModelSettings | null | undefined,
  field: AiProviderField,
  environmentFallback?: string
): AiProviderId {
  const saved = settings?.[field]
  if (saved && isAiProviderId(saved)) return saved
  const fallback = environmentFallback?.trim()
  return fallback && isAiProviderId(fallback) ? fallback : "codex"
}

/** Returns the complete provider/model/reasoning selection for one task. */
export function resolveAiTaskSelection(
  settings: AiModelSettings | null | undefined,
  task: AiTask,
  options: {
    modelEnvironmentFallback?: string
    effortEnvironmentFallback?: string
    providerEnvironmentFallback?: string
  } = {}
): {
  providerId: AiProviderId
  model: string
  effort: AiReasoningEffort
} {
  const modelField =
    task === "research"
      ? "researchModel"
      : task === "reply"
        ? "replyModel"
        : "cardGenerationModel"
  const effortField =
    task === "research"
      ? "researchEffort"
      : task === "reply"
        ? "replyEffort"
        : "cardGenerationEffort"
  return {
    providerId: resolveAiProvider(
      settings,
      AI_TASK_PROVIDER_FIELDS[task],
      options.providerEnvironmentFallback
    ),
    model: resolveAiModel(
      settings,
      modelField,
      options.modelEnvironmentFallback
    ),
    effort: resolveAiReasoningEffort(
      settings,
      effortField,
      options.effortEnvironmentFallback
    ) as AiReasoningEffort,
  }
}

/** Rejects newly saved task assignments that require unavailable source isolation. Legacy records remain readable. */
export function validateAiTaskProviders(settings: AiModelSettings): void {
  if (
    !AI_PROVIDER_TASKS[settings.cardGenerationProvider ?? "codex"].includes(
      "cardGeneration"
    )
  )
    throw new Error(
      "Antigravity supports interactive workspace chat only. Choose another provider for card generation."
    )
}
