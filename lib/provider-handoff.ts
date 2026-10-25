/**
 * Decides which providers a chat can move to after its provider hits a usage
 * limit, and names them for the chat. Shared by the chat screens and the chat
 * route; it has no server-only imports.
 */

import { AI_PROVIDER_OPTIONS, isAiProviderId, type AiProviderId } from "./ai-model-settings.ts"

/** The part of a provider check (`GET /api/providers`) a handoff offer needs. */
export interface HandoffAvailability {
  /** Provider the check is about. */
  readonly providerId: string
  /** Whether the runtime is installed and starts. */
  readonly available: boolean
  /** Whether it is signed in; null when the check could not tell. */
  readonly authenticated: boolean | null
}

/** Returns a provider's display name, or its ID when it is unknown. */
export function providerLabel(providerId: string): string {
  return (
    AI_PROVIDER_OPTIONS.find((option) => option.id === providerId)?.label ??
    providerId
  )
}

/**
 * Lists the providers a chat can continue on, in settings order: each one
 * other than the chat's own that is installed and signed in. A provider whose
 * sign-in the check could not confirm is left out rather than offered.
 *
 * @param currentProviderId - Provider that hit its limit.
 * @param providers - Results of the provider checks.
 */
export function handoffCandidates(
  currentProviderId: string,
  providers: readonly HandoffAvailability[]
): AiProviderId[] {
  return AI_PROVIDER_OPTIONS.map((option) => option.id).filter((id) => {
    if (id === currentProviderId) return false
    const check = providers.find((provider) => provider.providerId === id)
    return Boolean(
      check && isAiProviderId(check.providerId) && check.available && check.authenticated === true
    )
  })
}
