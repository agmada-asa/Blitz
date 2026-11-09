/**
 * Performs a claimed lesson update: asks the configured provider what the new
 * files change and hands the checked reply to Convex to merge. Runs outside the
 * lesson's own conversation, as a one-off turn, so the analysis cannot disturb
 * what the tutor remembers and needs no learner history.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel.js"
import {
  buildTeachUpdatePrompt,
  parseTeachUpdateReply,
  TEACH_UPDATE_SCHEMA,
} from "../teach-update-prompt.ts"
import { loadSavedAiModelSettings } from "./ai-model-settings.ts"
import { CardChatError } from "./card-chat.ts"
import { serverConvexClient } from "./convex.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"
import { chatReplySelection, savedChatReplySelection } from "./teach-turn-settings.ts"

/** Longest the analysis may take; shorter than the lease in `lib/teach-updates.ts`. */
const UPDATE_TIMEOUT_MS = 540_000

/** Returns a short learner-facing reason for a failed update. */
function failureMessage(error: unknown): string {
  if (error instanceof CardChatError && error.reason === "spend-limit") return error.message
  const message = error instanceof Error ? error.message : ""
  if (/usage limit|rate limit|quota/i.test(message))
    return "Your AI subscription's usage limit was reached. Try again later."
  if (/timed? ?out/i.test(message)) return "Reading the new files took too long. Try again."
  if (/JSON/i.test(message)) return "The update came back in the wrong format. Try again."
  return "The lesson could not be updated. Try again."
}

/**
 * Analyses the new files for a claimed update and applies the result. Never
 * throws: a failure is recorded on the run with a learner-facing message and
 * the lesson stays exactly as it was.
 *
 * @param chatId The Teach session claimed by `teachUpdates.begin`.
 * @param token The run's claim, so a late finish cannot overwrite a newer run.
 */
export async function runTeachUpdate(
  chatId: Id<"workspaceChats">,
  token: string
): Promise<void> {
  const client = serverConvexClient()
  const directory = await mkdtemp(join(tmpdir(), "blitz-teach-update-"))
  try {
    const context = await client.query(api.teachUpdates.runContext, { chatId, token })
    if (!context) throw new Error("This lesson update is no longer current")
    // The provider teaching this lesson does the analysis, so a lesson that can
    // be taught can be updated, whatever the background generation setting says.
    const selection = savedChatReplySelection(
      chatReplySelection(await loadSavedAiModelSettings(client)),
      await client.query(api.workspaceChats.replySelection, { chatId })
    )
    const result = await runProviderTextTurn({
      providerId: selection.providerId,
      model: selection.model,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      workspaceDirectory: directory,
      prompt: buildTeachUpdatePrompt(context),
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      timeoutMs: UPDATE_TIMEOUT_MS,
      outputSchema: TEACH_UPDATE_SCHEMA,
    })
    await client.mutation(api.teachUpdates.apply, {
      chatId,
      token,
      reply: parseTeachUpdateReply(result),
    })
  } catch (error) {
    console.error("A lesson update failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    })
    await client
      .mutation(api.teachUpdates.fail, { chatId, token, error: failureMessage(error) })
      .catch(() => undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
