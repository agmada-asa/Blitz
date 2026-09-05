/** Defines task-specific Codex model and reasoning settings shared by Blitz. */

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

/** One reasoning level that can be passed to a Codex turn. */
export type AiReasoningEffort = (typeof AI_REASONING_EFFORTS)[number]

/** One curated Codex model and the reasoning levels it supports in Blitz. */
export type CodexModelOption = {
  readonly id: string
  readonly label: string
  readonly reasoningEfforts: readonly AiReasoningEffort[]
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

/** Untrusted model and reasoning strings accepted at the persistence boundary. */
export type AiModelSettingsInput = Record<AiModelField, string> &
  Record<AiReasoningField, string>

/** One validated model and reasoning selection for every AI task Blitz runs. */
export type AiModelSettings = Record<AiModelField, string> &
  Record<AiReasoningField, AiReasoningEffort>

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
  ...DEFAULT_AI_MODELS,
  ...DEFAULT_AI_REASONING_EFFORTS,
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

/** Returns curated model choices while preserving one previously saved legacy model as selectable. */
export function getCodexModelPickerOptions(
  model: string
): readonly CodexModelOption[] {
  if (isKnownCodexModel(model)) return CODEX_MODEL_OPTIONS
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
  field: AiReasoningField
): AiReasoningEffort {
  const effort = value.trim() as AiReasoningEffort
  const label = AI_REASONING_FIELD_LABELS[field]
  if (!AI_REASONING_EFFORTS.includes(effort))
    throw new Error(`${label} reasoning level is not supported`)
  if (
    isKnownCodexModel(model) &&
    !getSupportedAiReasoningEfforts(model).includes(effort)
  ) {
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
  return {
    researchModel,
    replyModel,
    cardGenerationModel,
    researchEffort: validateAiReasoningEffort(
      settings.researchEffort,
      researchModel,
      "researchEffort"
    ),
    replyEffort: validateAiReasoningEffort(
      settings.replyEffort,
      replyModel,
      "replyEffort"
    ),
    cardGenerationEffort: validateAiReasoningEffort(
      settings.cardGenerationEffort,
      cardGenerationModel,
      "cardGenerationEffort"
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
