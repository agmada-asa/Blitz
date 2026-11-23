/**
 * The Teach parts of a workspace chat turn: the tutor's prompt, built from
 * the unit's material, outline, and plan, and what is saved once the tutor
 * has replied.
 */

import type { ConvexHttpClient } from "convex/browser"
import type { FunctionReturnType } from "convex/server"

import { api } from "../../../convex/_generated/api.js"
import type { Id } from "../../../convex/_generated/dataModel.js"
import {
  buildTeachPrompt,
  parseTeachOutline,
  parseTeachPlan,
  parseTeachSectionMarker,
  teachUnitTitle,
} from "../../teach.ts"
import type { CardChatResult } from "../card-chat.ts"
import { startFirstQuestionBank } from "../question-bank.ts"
import type { WorkspaceChatHistoryMessage } from "../workspace-chat.ts"
import { finishTurnContext } from "./functions.ts"

/** A Teach session's unit, material, and progress, as the turn starts. */
export type TeachContext = NonNullable<
  FunctionReturnType<typeof api.units.teachContext>
>

/** The learner's saved pre-check answers, sent with `Plan my lesson`. */
export type TeachPrecheck = FunctionReturnType<typeof api.teach.precheckResults>

/**
 * Builds a Teach turn's prompt, with the unit material when the session
 * needs it. After a compaction the material, outline, and plan are restated
 * but the dialogue is left to the runtime's summary.
 *
 * @param teach - The session's context.
 * @param options.message - What the tutor is asked this turn.
 * @param options.includeContext - Whether to send the rules and unit material.
 * @param options.afterCompaction - Whether the session was just compacted.
 * @param options.history - The session's saved messages.
 * @param options.precheck - Pre-check answers, for `Plan my lesson`.
 * @param options.precheckContext - The same answers on later turns, restated
 *   with the plan when the session is rebuilt so skimmed sections stay targeted.
 */
export function teachTurnPrompt(
  teach: TeachContext,
  options: {
    message: string
    includeContext: boolean
    afterCompaction?: boolean
    history: readonly WorkspaceChatHistoryMessage[]
    precheck?: TeachPrecheck
    precheckContext?: TeachPrecheck
  }
): string {
  return buildTeachPrompt({
    moduleTitle: teach.moduleTitle,
    unitTitle: teach.unitTitle,
    sources: teach.sources.map((source) => ({
      filename: source.filename,
      ...(source.relativeKey ? { relativeKey: source.relativeKey } : {}),
      text: source.text,
    })),
    message: options.message,
    includeContext: options.includeContext,
    ...(options.afterCompaction ? { afterCompaction: true } : {}),
    history: options.afterCompaction
      ? []
      : options.history
          .filter((message) => message.content.trim())
          .map((message) => ({ role: message.role, content: message.content })),
    ...(teach.outline ? { outline: teach.outline } : {}),
    ...(teach.sectionIndex !== null ? { sectionIndex: teach.sectionIndex } : {}),
    ...(teach.plan ? { plan: teach.plan } : {}),
    ...(teach.update ? { update: teach.update } : {}),
    ...(options.precheck ? { precheck: options.precheck } : {}),
    ...(options.precheckContext ? { precheckContext: options.precheckContext } : {}),
    knownConcepts: teach.knownConcepts,
    references: teach.referenceExcerpts,
  })
}

/**
 * Saves what a finished Teach reply changed: how full the session is, the
 * outline, plan, and section the reply set, and the unit's title. Once the
 * unit has an outline, its first question bank starts in the background so
 * Practice and Review have material by the time the learner wants them.
 * Failures are logged. It runs before the reply is marked complete, so the
 * chat never goes idle with stale progress.
 *
 * @param client - Convex client for the personal deployment.
 * @param turn - The reply and the session it belongs to.
 * @param turn.restated - Whether this turn sent the unit material again and
 *   the runtime did not compact after it, clearing a pending restatement.
 */
export async function finishTeachTurn(
  client: ConvexHttpClient,
  turn: {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    teach: TeachContext
    reply: string
    /** Whether the reply answers `Plan my lesson`. */
    planning: boolean
    contextUsage: CardChatResult["contextUsage"]
    restated: boolean
  }
): Promise<void> {
  const { chatId, teach, reply } = turn
  await client
    .mutation(finishTurnContext, {
      chatId,
      messageId: turn.messageId,
      ...(turn.contextUsage
        ? { usage: { ...turn.contextUsage, updatedAt: Date.now() } }
        : {}),
      restated: turn.restated,
      updateDelivered: Boolean(teach.update),
    })
    .catch((error: unknown) => {
      console.warn("Teach could not save context usage", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
  // Progress is derived from the finished reply, never from the client.
  const outline = parseTeachOutline(reply)
  const marker = parseTeachSectionMarker(reply)
  const knownOutline = teach.outline ?? outline
  // Only the reply to `Plan my lesson` sets the plan. A later turn saves the
  // plan recovered from that reply if saving it failed the first time.
  const plan = !knownOutline || teach.planSaved
    ? undefined
    : turn.planning
      ? parseTeachPlan(reply, knownOutline)
      : (teach.plan ?? undefined)
  await client
    .mutation(api.units.recordTeachProgress, {
      chatId,
      ...(outline ? { outline } : {}),
      ...(plan ? { plan } : {}),
      ...(marker
        ? { sectionId: marker.kind === "done" ? "done" : marker.id }
        : {}),
      ...(outline && teach.unitTitleSource === "auto"
        ? { unitTitle: teachUnitTitle(teach.unitTitle, outline.title) }
        : {}),
      // Fixes the files this outline was written from, for spotting later ones.
      ...(outline && !teach.outline
        ? { coveredSourceIds: teach.sources.map((source) => source.id) }
        : {}),
    })
    .catch((error: unknown) => {
      console.error("Teach progress could not be saved", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
  // The bank call is a no-op after the first.
  if (knownOutline)
    void startFirstQuestionBank(teach.unitId).catch((error: unknown) => {
      console.error("First question bank could not start", {
        message: error instanceof Error ? error.message : "Unknown error",
      })
    })
}
