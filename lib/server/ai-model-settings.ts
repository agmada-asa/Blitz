/** Loads validated AI model and reasoning settings for workers and generation routes. */

import { ConvexHttpClient } from "convex/browser"

import { api } from "../../convex/_generated/api.js"
import {
  validateAiModelSettings,
  type AiModelSettings,
} from "../ai-model-settings.ts"

/** Invalid saved settings must be corrected rather than replaced by another provider. */
export class SavedModelSettingsError extends Error {
  /** Carries a bounded validation explanation with a concrete recovery action. */
  constructor(message: string) {
    super(`${message}. Update your model settings before trying again.`)
    this.name = "SavedModelSettingsError"
  }
}

/** Reads saved settings; invalid saved choices fail explicitly rather than switching providers through defaults. */
export async function loadSavedAiModelSettings(
  client: ConvexHttpClient | null
): Promise<AiModelSettings | null> {
  if (!client) return null
  const settings = await client.query(api.settings.get)
  if (!settings) return null
  try {
    return validateAiModelSettings(settings)
  } catch (error) {
    throw new SavedModelSettingsError(error instanceof Error ? error.message : "The saved model settings are invalid")
  }
}
