/** Defines task-specific Codex model settings shared by the web app and local workers. */

/** Names the persisted model field used for each kind of AI work. */
export const AI_MODEL_FIELDS = [
  "researchModel",
  "replyModel",
  "cardGenerationModel",
] as const

/** One model selection for every AI task Blitz currently runs. */
export type AiModelSettings = Record<(typeof AI_MODEL_FIELDS)[number], string>

/** A field name that selects one configured AI task. */
export type AiModelField = (typeof AI_MODEL_FIELDS)[number]

/** Model used by each task before a setting or legacy environment fallback exists. */
export const DEFAULT_AI_MODELS: Readonly<AiModelSettings> = {
  researchModel: "gpt-5.6-luna",
  replyModel: "gpt-5.6-luna",
  cardGenerationModel: "gpt-5.6-luna",
}

/** Keeps persisted model IDs bounded before they reach the local Codex bridge. */
export const MAX_AI_MODEL_NAME_LENGTH = 120

/** Labels settings in validation messages without leaking implementation field names. */
const AI_MODEL_FIELD_LABELS: Record<AiModelField, string> = {
  researchModel: "Research",
  replyModel: "Reply",
  cardGenerationModel: "Card generation",
}

/** Accepts the punctuation used by Codex model IDs while rejecting whitespace and control text. */
const AI_MODEL_NAME_PATTERN = /^[A-Za-z0-9._:/@-]+$/

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

/** Validates all task selections before they are saved or handed to a worker. */
export function validateAiModelSettings(
  settings: AiModelSettings
): AiModelSettings {
  return {
    researchModel: validateAiModelName(settings.researchModel, "researchModel"),
    replyModel: validateAiModelName(settings.replyModel, "replyModel"),
    cardGenerationModel: validateAiModelName(
      settings.cardGenerationModel,
      "cardGenerationModel"
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
