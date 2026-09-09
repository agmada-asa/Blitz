/**
 * Generates succinct titles for newly created workspace chats.
 *
 * Owns the prompt assembly, output sanitization, and execution lifecycle for
 * generating compact chat titles through the cheapest available provider model
 * with lowest or no reasoning effort.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  resolveCheapestAiModelSelection,
  type AiProviderId,
} from "../ai-model-settings.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"

/** Maximum character length allowed for a persisted chat title. */
export const MAX_CHAT_TITLE_LENGTH = 64

/** Wall-clock timeout for lightweight title generation before falling back. */
const TITLE_GENERATION_TIMEOUT_MS = 15_000

/**
 * Builds the text prompt sent to the cheapest model to generate a succinct chat title.
 *
 * @param message - The first message sent by the user in the new chat.
 * @param contextLabels - Optional labels of attached context items (files, cards, projects).
 * @returns The prepared instruction prompt.
 */
export function buildChatTitlePrompt(
  message: string,
  contextLabels: readonly string[] = []
): string {
  const cleanMessage = message.trim().slice(0, 2_000)
  const contextSnippet = contextLabels.length
    ? `Context items attached to this chat: ${contextLabels.join(", ")}\n\n`
    : ""
  return (
    `You are generating a concise, succinct title for a new chat based on the user's first message.\n\n` +
    `${contextSnippet}` +
    `User message:\n"""\n${cleanMessage}\n"""\n\n` +
    `Requirements:\n` +
    `- Provide a succinct, descriptive title between 2 and 6 words.\n` +
    `- Capture the core topic, intention, or question.\n` +
    `- Output ONLY the plain title text with no surrounding quotes, no markdown, no prefixes like "Title:", and no trailing punctuation.\n` +
    `- Must be under 60 characters.`
  )
}

/**
 * Cleans, sanitizes, and bounds raw model output to fit within Convex chat title limits.
 *
 * Strips formatting artifacts such as surrounding quotation marks, markdown decoration,
 * leading labels (e.g. "Title:"), and trailing punctuation, falling back to the initial
 * fallback string if the model returns blank or malformed text.
 *
 * @param rawText - Raw text response from the model.
 * @param fallback - Fallback title to use if the text is empty or invalid.
 * @returns A clean, single-line title bounded to at most 64 characters.
 */
export function parseChatTitleOutput(
  rawText: string,
  fallback: string
): string {
  let text = rawText.trim()
  // Remove markdown formatting like backticks, bold, italic, or headers.
  text = text.replace(/[*_`#]/g, "")
  // Remove common leading label prefixes.
  text = text.replace(/^(?:title|subject|chat title)\s*:\s*/i, "")
  // Remove wrapping quotes and typographic quotation marks.
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim()
  // Retain only the first line and collapse multiple whitespace characters.
  text = text.split(/\r?\n/)[0]?.trim().replace(/\s+/g, " ") ?? ""
  // Strip trailing period, colon, or semicolons.
  text = text.replace(/[.:;!]+$/, "").trim()
  if (!text) return fallback
  return text.length <= MAX_CHAT_TITLE_LENGTH
    ? text
    : `${text.slice(0, MAX_CHAT_TITLE_LENGTH - 1).trimEnd()}…`
}

/**
 * Options for executing chat title generation.
 */
export interface GenerateChatTitleOptions {
  /** The first user message initiating the chat. */
  readonly message: string
  /** Optional human-readable labels of attached cards, files, or projects. */
  readonly contextLabels?: readonly string[]
  /** The provider chosen or running for the chat session. */
  readonly providerId: AiProviderId
  /** Optional provider instance identifier. */
  readonly providerInstanceId?: string
  /** Fallback title used if generation fails or produces empty output. */
  readonly fallbackTitle: string
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal
}

/**
 * Generates a succinct chat title using the cheapest model available with lowest/no reasoning.
 *
 * Runs an isolated, ephemeral turn without tool access or web search. If generation times out,
 * errors, or produces invalid output, it safely catches the error and returns the fallback title.
 *
 * @param options - Parameters for the title generation turn.
 * @returns The succinct generated title, or the fallback title on failure.
 */
export async function generateChatTitle(
  options: GenerateChatTitleOptions
): Promise<string> {
  const selection = resolveCheapestAiModelSelection(options.providerId, {
    modelEnvironmentFallback: process.env.BLITZ_TITLE_MODEL,
    effortEnvironmentFallback: process.env.BLITZ_TITLE_EFFORT,
  })

  // Create an isolated temporary workspace directory for this ephemeral turn.
  const directory = await mkdtemp(join(tmpdir(), "blitz-title-"))
  try {
    const result = await runProviderTextTurn({
      providerId: selection.providerId,
      ...(options.providerInstanceId
        ? { providerInstanceId: options.providerInstanceId }
        : {}),
      model: selection.model,
      effort: selection.effort,
      workspaceDirectory: directory,
      prompt: buildChatTitlePrompt(options.message, options.contextLabels),
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      signal: options.signal,
      timeoutMs: TITLE_GENERATION_TIMEOUT_MS,
    })
    return parseChatTitleOutput(result.text, options.fallbackTitle)
  } catch {
    // If the provider fails, times out, or is interrupted, gracefully preserve the fallback title.
    return options.fallbackTitle
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
