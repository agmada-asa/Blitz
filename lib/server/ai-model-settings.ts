/** Loads validated AI model and reasoning settings for workers and generation routes. */

import { ConvexHttpClient } from "convex/browser"

import { api } from "../../convex/_generated/api.js"
import {
  validateAiModelSettings,
  type AiModelSettings,
} from "../ai-model-settings.ts"

/** Reads saved settings and falls back safely when Convex is unavailable or returns bad data. */
export async function loadSavedAiModelSettings(
  client: ConvexHttpClient | null
): Promise<AiModelSettings | null> {
  if (!client) return null
  try {
    const settings = await client.query(api.settings.get)
    return settings ? validateAiModelSettings(settings) : null
  } catch {
    return null
  }
}
