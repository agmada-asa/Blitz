/**
 * Which runtime features each Blitz provider supports: the thread operations
 * (fork, rewind, compaction, context usage, prewarm) and the turn options
 * (reply schema, spending caps, plan mode, document files).
 *
 * Every provider runs through agent-engines. Codex and Claude Code have their
 * own engines, which support all of these apart from spending caps on Codex.
 * OpenCode runs on the library's ACP engine, which supports none of them and
 * throws `UnsupportedFeatureError` when one is set, so OpenCode chats keep
 * their earlier behaviour: branches and edits replay the transcript, Teach
 * replies cannot be redone in place, the context meter stays hidden, no
 * compaction runs, Plan first is ignored, and background work parses plain
 * text from the extracted material.
 *
 * Shared by the server, which leaves an unsupported option out of the turn,
 * and the screens, so a control only appears where the operation works.
 */

import type { AiProviderId } from "./ai-model-settings.ts"

/** Runtime features one provider supports. */
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
  /** Enforce a JSON Schema on the reply and return it parsed (`outputSchema`). */
  readonly outputSchema: boolean
  /** Stop a turn at a cost or step limit (`limits`). */
  readonly spendingCaps: boolean
  /** Propose a plan for approval before changing anything (`mode: "plan"`). */
  readonly planMode: boolean
  /** Read files passed with the turn as documents or by path (`files`). */
  readonly documents: boolean
}

/** Support by provider. A provider not listed supports none of them. */
const FEATURES: Partial<Record<AiProviderId, ProviderThreadFeatures>> = {
  codex: {
    fork: true,
    rewind: true,
    compact: true,
    contextUsage: true,
    prewarm: true,
    outputSchema: true,
    spendingCaps: false,
    planMode: true,
    documents: true,
  },
  "claude-code": {
    fork: true,
    rewind: true,
    compact: true,
    contextUsage: true,
    prewarm: true,
    outputSchema: true,
    spendingCaps: true,
    planMode: true,
    documents: true,
  },
}

/** No runtime features: OpenCode, and any provider id Blitz does not know. */
const NONE: ProviderThreadFeatures = {
  fork: false,
  rewind: false,
  compact: false,
  contextUsage: false,
  prewarm: false,
  outputSchema: false,
  spendingCaps: false,
  planMode: false,
  documents: false,
}

/**
 * Returns the runtime features a provider supports.
 * @param providerId - A Blitz provider id; unknown or missing ids get none.
 */
export function providerThreadFeatures(
  providerId: string | null | undefined
): ProviderThreadFeatures {
  return (providerId && FEATURES[providerId as AiProviderId]) || NONE
}
