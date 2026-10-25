/**
 * Which thread operations each Blitz provider supports: fork, rewind,
 * compaction, context usage, and prewarm.
 *
 * Codex and Claude Code run through agent-engines, whose `capabilities()`
 * report all five. OpenCode runs on Blitz's own ACP adapter, which has none
 * of them, so OpenCode chats keep today's behaviour: branches and edits replay
 * the transcript, Teach replies cannot be redone in place, the context meter
 * stays hidden, and no compaction runs. Shared by the server and the screens,
 * so a control only appears where the operation works.
 */

import type { AiProviderId } from "./ai-model-settings.ts"

/** Thread operations one provider supports. */
export type ProviderThreadFeatures = {
  /** Branch or edit by copying the runtime's own thread through a turn. */
  readonly fork: boolean
  /** Drop the latest turns so a reply can be redone in place. */
  readonly rewind: boolean
  /** Summarise the thread's context to free room. */
  readonly compact: boolean
  /** Report how full the context window is. */
  readonly contextUsage: boolean
  /** Start the runtime before the first message so the first reply comes sooner. */
  readonly prewarm: boolean
}

/** Support by provider. A provider not listed supports none of them. */
const FEATURES: Partial<Record<AiProviderId, ProviderThreadFeatures>> = {
  codex: { fork: true, rewind: true, compact: true, contextUsage: true, prewarm: true },
  "claude-code": { fork: true, rewind: true, compact: true, contextUsage: true, prewarm: true },
}

/** No thread operations: OpenCode, and any provider id Blitz does not know. */
const NONE: ProviderThreadFeatures = {
  fork: false,
  rewind: false,
  compact: false,
  contextUsage: false,
  prewarm: false,
}

/**
 * Returns the thread operations a provider supports.
 * @param providerId - A Blitz provider id; unknown or missing ids get none.
 */
export function providerThreadFeatures(
  providerId: string | null | undefined
): ProviderThreadFeatures {
  return (providerId && FEATURES[providerId as AiProviderId]) || NONE
}
