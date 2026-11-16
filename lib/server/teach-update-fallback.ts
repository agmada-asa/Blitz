/**
 * Runs a lesson update's analysis on the lesson's own provider and, when that
 * provider stops at a usage or rate limit, on the next signed-in provider.
 *
 * A Teach session stays on the provider it started with, because its
 * conversation lives there. A lesson update reads only the unit, its outline
 * and the new files in a one-off turn (`teach-update.ts`), so it does not need
 * that conversation and can run anywhere. Without this, a lesson taught on a
 * provider at its limit could not be updated until the limit reset.
 */

import type { AiProviderId } from "../ai-model-settings.ts"
import { updateFallbackProviders, type HandoffAvailability } from "../provider-handoff.ts"
import { CardChatError } from "./card-chat.ts"

/** The provider, model and effort one attempt runs with. */
export type UpdateSelection = {
  readonly providerId: AiProviderId
  readonly model: string
  readonly effort?: string
}

/** What the fallback needs from its caller, so tests can stand in for real providers. */
export interface UpdateFallbackOptions<Result> {
  /** The lesson's own provider, tried first. */
  readonly lesson: UpdateSelection
  /** Reply provider chosen in Settings, preferred among the fallbacks. */
  readonly configuredProviderId: AiProviderId
  /** Model and effort to use on a fallback provider. */
  readonly selectionFor: (providerId: AiProviderId) => UpdateSelection
  /** Checks which providers are installed and signed in. Called only after a limit. */
  readonly checkProviders: () => Promise<readonly HandoffAvailability[]>
  /** Runs the analysis on one provider. */
  readonly run: (selection: UpdateSelection) => Promise<Result>
}

/**
 * Whether an error means the provider is at a usage, quota or rate limit,
 * which another provider may not be.
 *
 * @param error - What the provider turn threw.
 */
export function stoppedAtLimit(error: unknown): boolean {
  if (
    error instanceof CardChatError &&
    (error.reason === "usage-limit" || error.reason === "rate-limit")
  )
    return true
  const message = error instanceof Error ? error.message : ""
  return /usage limit|rate limit|quota/i.test(message)
}

/**
 * Runs the analysis on the lesson's provider, then on each other signed-in
 * provider in turn while every attempt stops at a limit.
 *
 * @returns The first successful result and the provider that produced it.
 * @throws The lesson provider's error when it failed for another reason, when
 *   no other provider is signed in, or when every one is also at a limit. A
 *   fallback that fails for any other reason throws its own error.
 */
export async function runWithLimitFallback<Result>(
  options: UpdateFallbackOptions<Result>
): Promise<{ result: Result; providerId: AiProviderId }> {
  try {
    return { result: await options.run(options.lesson), providerId: options.lesson.providerId }
  } catch (error) {
    if (!stoppedAtLimit(error)) throw error
    // A failed check only means nothing to fall back to; report the limit.
    const checks = await options.checkProviders().catch(() => [])
    const fallbacks = updateFallbackProviders(
      options.lesson.providerId,
      options.configuredProviderId,
      checks
    )
    for (const providerId of fallbacks) {
      try {
        return { result: await options.run(options.selectionFor(providerId)), providerId }
      } catch (fallbackError) {
        if (!stoppedAtLimit(fallbackError)) throw fallbackError
      }
    }
    throw error
  }
}
