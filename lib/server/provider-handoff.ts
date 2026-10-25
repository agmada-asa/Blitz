/**
 * Carries a chat's conversation from one provider to another when the learner
 * continues on a different provider after a usage limit.
 *
 * The old provider's session is read back through agent-engines and becomes
 * the new session's `seed`, so the new provider sees the conversation as the
 * old one had it, including the tools it ran and what they returned. Blitz's
 * own transcript replay rebuilds only the messages and attachments, so it
 * stays the fallback when the old session cannot be read.
 */

import {
  renderTranscript,
  type Engine,
  type HistoryTurn,
  type PortableTranscript,
  type TranscriptEntry,
} from "agent-engines"

import type { AiProviderId } from "../ai-model-settings.ts"
import { createProviderEngine } from "./providers/engines.ts"
import { createOpenCodeEngine } from "./providers/opencode.ts"

/** Most transcript text carried into a new session, in characters. */
export const MAX_HANDOFF_CHARACTERS = 120_000

/** Longest single message kept whole; Blitz prompts embed source excerpts. */
const MAX_HANDOFF_MESSAGE = 12_000

/** How long reading the old session may take before Blitz replays instead. */
const HANDOFF_READ_TIMEOUT_MS = 30_000

/** The provider and session a chat is moving away from. */
export interface ProviderHandoff {
  /** Provider the chat used before the usage limit. */
  readonly fromProviderId: string
  /** That provider's session, when the chat had one. */
  readonly fromSessionId?: string
}

/** Shortens one long text to its start and end around an elision mark. */
function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text
  const half = Math.floor((limit - 3) / 2)
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`
}

/** Returns one entry with its message text shortened, leaving others as they are. */
function fitEntry(entry: TranscriptEntry): TranscriptEntry {
  return entry.kind === "message"
    ? { ...entry, text: shorten(entry.text, MAX_HANDOFF_MESSAGE) }
    : entry
}

/**
 * Trims a transcript to a size a new session can take: long messages are
 * shortened, reasoning is dropped, and the oldest turns go first when the
 * whole is still too long. The newest turn is always kept.
 *
 * @param transcript - The old session as exported.
 * @param maxCharacters - Budget for the rendered transcript.
 * @returns A transcript whose rendering fits the budget, unless its newest
 *   turn alone is larger.
 */
export function fitTranscript(
  transcript: PortableTranscript,
  maxCharacters = MAX_HANDOFF_CHARACTERS
): PortableTranscript {
  const turns: HistoryTurn[] = transcript.turns.map((turn) => ({
    ...turn,
    entries: turn.entries
      .filter((entry) => entry.kind !== "reasoning")
      .map(fitEntry),
  }))
  const kept: HistoryTurn[] = []
  let size = 0
  // Walk back from the newest turn, keeping turns while they fit.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!
    const turnSize = renderTranscript({ ...transcript, turns: [turn] }).length
    if (kept.length && size + turnSize > maxCharacters) break
    kept.unshift(turn)
    size += turnSize
  }
  return { ...transcript, turns: kept }
}

/**
 * Opens the engine that can read a provider's saved session.
 *
 * OpenCode runs with background permissions, since reading its session back
 * needs no tools.
 */
function readerEngine(providerId: AiProviderId, cwd: string): Engine {
  return providerId === "opencode"
    ? createOpenCodeEngine({ ephemeral: true }, cwd)
    : createProviderEngine(providerId)
}

/** Rejects after a bounded wait, so a stuck runtime cannot hold the turn. */
function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out")), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Reads the old provider's session and trims it into a seed.
 *
 * Reading starts no model turn, so it works while that provider is at its
 * usage limit. It never throws: the chat falls back to its own replay.
 *
 * @param handoff - The provider and session being left.
 * @param cwd - Workspace the old session ran in.
 * @param open - Opens the reader engine; tests pass a fake.
 * @returns The seed, or undefined when there is no session, it cannot be
 *   read in time, or it holds no turns.
 */
export async function readHandoffTranscript(
  handoff: ProviderHandoff,
  cwd: string,
  open: (providerId: AiProviderId, cwd: string) => Engine = readerEngine
): Promise<PortableTranscript | undefined> {
  if (!handoff.fromSessionId) return undefined
  const providerId = handoff.fromProviderId as AiProviderId
  let engine: Engine | undefined
  try {
    engine = open(providerId, cwd)
    const history = await withTimeout(
      engine.readThread(handoff.fromSessionId, { cwd }),
      HANDOFF_READ_TIMEOUT_MS
    )
    const transcript = fitTranscript({
      provider: history.provider,
      threadId: history.id,
      turns: history.turns,
    })
    return transcript.turns.length ? transcript : undefined
  } catch (error) {
    console.warn("The previous provider's session could not be read", {
      providerId,
      message: error instanceof Error ? error.message : "Unknown error",
    })
    return undefined
  } finally {
    await engine?.close().catch(() => undefined)
  }
}

/**
 * Adds a note to the first prompt on the new provider: which provider ran the
 * conversation, and where its stopped reply ended, since a reply cut off by a
 * usage limit may not be in the old session's record.
 *
 * @param prompt - The turn's prompt.
 * @param fromProviderName - Display name of the provider being left.
 * @param stoppedReply - Text of the stopped reply so far, if any.
 */
export function handoffPrompt(
  prompt: string,
  fromProviderName: string,
  stoppedReply: string
): string {
  const tail = stoppedReply.trim().slice(-2_000)
  const note = tail
    ? `The earlier conversation was with ${fromProviderName}, which stopped at its usage limit partway through its last reply. That reply ended with:\n<stopped_reply>\n${tail}\n</stopped_reply>`
    : `The earlier conversation was with ${fromProviderName}, which stopped at its usage limit before it could answer the last message.`
  return `${note}\n\n${prompt}`
}
