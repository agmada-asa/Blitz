/**
 * Streams general workspace chat turns through the selected Blitz provider.
 *
 * Teach sessions run here too. Around each turn the route copies a branched
 * chat's runtime session instead of replaying its transcript, redoes a Teach
 * reply in place by rewinding its turn, compacts a long Teach session before
 * it overflows (and restates the unit material, outline, and plan after), and
 * finishes a reply cut off by a full context once compaction frees room.
 * Refusals, denied tools, and safety checks are saved beside the reply.
 *
 * The pieces live in `lib/server/chat-turn/`: the Convex functions a turn
 * calls, its files and images, its access settings, the handling of each
 * provider event, transcript replay, and the Teach prompt and bookkeeping.
 */

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { CHAT_PROVIDER_CAPABILITIES } from "@/lib/provider-capabilities"
import { providerThreadFeatures } from "@/lib/provider-thread-features"
import { providerLabel } from "@/lib/provider-handoff"
import { citationPrompt } from "@/lib/citations"
import {
  parseTeachSectionMarker,
  TEACH_QUICK_REPLIES,
  teachRedoMessage,
} from "@/lib/teach"
import { TEACH_MOVED_ON } from "@/lib/teach-focus"
import type { AiProviderId } from "@/lib/ai-model-settings"
import { createChatAgentSession } from "@/lib/server/chat-agent"
import {
  prepareProjectAgentWorkspace,
  projectAgentInstructions,
  scanProjectArtifacts,
} from "@/lib/server/project-agent"
import type { ConvexHttpClient } from "convex/browser"
import type { PortableTranscript } from "agent-engines"
import { serverConvexClient } from "@/lib/server/convex"
import { CardChatError } from "@/lib/server/card-chat"
import { createChatProgress } from "@/lib/server/chat-progress"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import {
  workspaceChatFailure,
  workspaceChatFailureDetail,
} from "@/lib/server/workspace-chat-failure"
import { runProviderTextTurn } from "@/lib/server/providers/run-text-turn"
import {
  handoffPrompt,
  readHandoffTranscript,
} from "@/lib/server/provider-handoff"
import { getCodexModelCatalog } from "@/lib/server/providers/codex-models"
import type { ProviderImageAttachment } from "@/lib/server/providers/types"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import { generateChatTitle } from "@/lib/server/chat-title"
import {
  chatReplySelection,
  savedChatReplySelection,
  teachTurnSettings,
} from "@/lib/server/teach-turn-settings"
import { registerChatRun } from "@/lib/server/chat-run-registry"
import {
  buildWorkspaceChatPrompt,
  combineWorkspaceChatContinuation,
  overflowContinuationMessage,
  parseWorkspaceChatRequest,
} from "@/lib/server/workspace-chat"
import {
  appendReplayImages,
  chatWorkspaceDirectory,
  resolveSubmittedAttachments,
  stageWorkspaceAttachments,
} from "@/lib/server/chat-turn/attachments"
import {
  createActivityLog,
  createTurnEvents,
  type ActivityLog,
} from "@/lib/server/chat-turn/events"
import {
  completeWorkspaceTurn,
  failWorkspaceTurn,
  getCardContext,
  getProjectContext,
  saveWorkspaceProgress,
  startWorkspaceTurn,
  type PersistedAttachment,
} from "@/lib/server/chat-turn/functions"
import { replayedChatPrompt } from "@/lib/server/chat-turn/replay"
import {
  spokenPrompt,
  turnAgentSettings,
  turnApprovalPolicy,
  turnSandbox,
  applySpokenModel,
} from "@/lib/server/chat-turn/settings"
import { finishTeachTurn, teachTurnPrompt } from "@/lib/server/chat-turn/teach"

/** Uses Node.js because each turn starts the selected local provider process. */
export const runtime = "nodejs"
/** Leaves cleanup time beyond the workspace chat's ten-minute turn and approval deadline. */
export const maxDuration = 620

/** Source lookups often need longer than the card-chat default deadline. */
const WORKSPACE_CHAT_TIMEOUT_MS = 600_000

/** Creates a server-side Convex client for resolving attached project context. */
function convexClient(): ConvexHttpClient {
  return serverConvexClient(() => new Error("Project context is unavailable"))
}

/** Reads a bounded JSON request without allowing attachments to exhaust route memory. */
async function readRequestJson(request: Request): Promise<unknown> {
  const maximumBytes = 140_000
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > maximumBytes) throw new Error("Chat request is too large")
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > maximumBytes)
    throw new Error("Chat request is too large")
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error("Chat request must be valid JSON")
  }
}

/** Encodes one newline-delimited event for the browser stream. */
function eventLine(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

/**
 * Replaces a new chat's first-message title with a short generated one,
 * unless the learner renamed the chat meanwhile. Any failure keeps the
 * first title.
 */
async function nameChat(
  client: ConvexHttpClient,
  chat: {
    chatId: Id<"workspaceChats">
    providerId: AiProviderId
    providerInstanceId?: string
  },
  initialTitle: string,
  message: string,
  contextLabels: string[]
): Promise<void> {
  try {
    const succinctTitle = await generateChatTitle({
      message,
      contextLabels,
      providerId: chat.providerId,
      providerInstanceId: chat.providerInstanceId,
      fallbackTitle: initialTitle,
    })
    if (succinctTitle && succinctTitle !== initialTitle) {
      await client.mutation(api.workspaceChats.setGeneratedTitle, {
        chatId: chat.chatId,
        title: succinctTitle,
        expectedCurrentTitle: initialTitle,
      })
    }
  } catch {
    // Chat retains initialTitle on any unexpected generation or update failure.
  }
}

/** Starts or resumes one read-only Blitz conversation with optional source context. */
export async function POST(request: Request): Promise<Response> {
  let input
  try {
    if (!isTrustedBlitzOrigin(request))
      throw new Error("Open Blitz to send a chat message")
    input = parseWorkspaceChatRequest(await readRequestJson(request))
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Chat request is invalid",
      },
      { status: 400 }
    )
  }

  const turnAbort = new AbortController()
  const turnSignal = AbortSignal.any([
    turnAbort.signal,
    AbortSignal.timeout(WORKSPACE_CHAT_TIMEOUT_MS),
  ])
  let deliveryCancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let agentSession: ReturnType<typeof createChatAgentSession> | undefined
      let activeTurn:
        | {
            chatId: Id<"workspaceChats">
            assistantMessageId: Id<"workspaceChatMessages">
          }
        | undefined
      let progress: ReturnType<typeof createChatProgress> | undefined
      let activity: ActivityLog | undefined
      let events: ReturnType<typeof createTurnEvents> | undefined
      let titlePromise: Promise<void> | undefined
      let unregisterRun: (() => void) | undefined
      /** Writes one event while tolerating a browser that has left the page. */
      const send = (value: unknown): void => {
        if (closed || deliveryCancelled) return
        try {
          controller.enqueue(eventLine(value))
        } catch {
          closed = true
        }
      }
      try {
        const client = convexClient()
        const ownerProjectId = input.chatId
          ? (
              await client.query(api.workspaceChats.get, {
                chatId: input.chatId,
              })
            )?.projectId
          : input.projectId
        const native = await resolveSubmittedAttachments(
          client,
          input.attachments,
          {
            ...(ownerProjectId ? { ownerProjectId } : {}),
            ...(input.chatId ? { chatId: input.chatId } : {}),
          }
        )
        // "What does this mean?" has no topic words, so quoted text counts too.
        const retrievalQuestion = [
          input.message.trim(),
          ...(input.annotations ?? []).map((a) => a.selectedText),
        ]
          .join(" ")
          .slice(0, 500)
          .trim()
        const projects = input.projectIds.length
          ? await client.query(getProjectContext, {
              projectIds: input.projectIds,
              question: retrievalQuestion || undefined,
            })
          : []
        const card = input.card
          ? await client.query(getCardContext, input.card)
          : undefined
        const persistedAttachments: PersistedAttachment[] = [
          ...(card
            ? [
                {
                  kind: "card" as const,
                  label: card.title,
                  projectId: card.projectId,
                  itemId: card.id,
                },
              ]
            : []),
          ...projects.map((project) => ({
            kind: "project" as const,
            label: project.title,
            projectId: project.id,
          })),
          ...input.attachments,
        ]
        const modelSettings = await loadSavedAiModelSettings(client)
        const configuredSelection = chatReplySelection(modelSettings)
        const requestedSelection = savedChatReplySelection(
          configuredSelection,
          input.chatId
            ? await client.query(api.workspaceChats.replySelection, { chatId: input.chatId })
            : null
        )
        const turn = await client
          .mutation(startWorkspaceTurn, {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          providerId: requestedSelection.providerId,
          providerModel: requestedSelection.model,
          providerEffort: requestedSelection.effort,
          ...(input.continuationOf
            ? { continuationOf: input.continuationOf }
            : {}),
          ...(input.steeringPrompt
            ? { steeringPrompt: input.steeringPrompt }
            : {}),
          clientMessageId: input.clientMessageId,
          message: input.message,
          attachments: persistedAttachments,
          ...(input.annotations?.length
            ? { annotations: input.annotations }
            : {}),
          ...(input.redo
            ? { redoOf: input.redo.messageId, redoStyle: input.redo.style }
            : {}),
          ...(input.after ? { after: input.after } : {}),
          })
          .catch((error: unknown) => {
            // Said plainly, so the Teach screen knows another tab moved on.
            if (error instanceof Error && error.message.includes(TEACH_MOVED_ON))
              throw new CardChatError("invalid-input", TEACH_MOVED_ON, error)
            throw error
          })
        activeTurn = {
          chatId: turn.chatId,
          assistantMessageId: turn.assistantMessageId,
        }
        const replyIds = {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
        }
        unregisterRun = registerChatRun(
          turn.chatId,
          turn.assistantMessageId,
          turnAbort,
          Date.now() + WORKSPACE_CHAT_TIMEOUT_MS
        )
        // A continued reply that stopped before any text resends its request
        // in place of the continue instruction.
        const turnInput =
          turn.resentMessage === undefined
            ? input
            : { ...input, message: turn.resentMessage }
        // A redo resends the request its replaced reply answered.
        const learnerMessage =
          turn.redo?.tutorMessage ?? turn.redo?.originalMessage ?? turnInput.message
        const resumedSection = turn.replyPrefix
          ? parseTeachSectionMarker(turn.replyPrefix)
          : undefined
        // A Teach session is a chat with its unit's material and protocol.
        const teach = input.chatId
          ? await client.query(api.units.teachContext, {
              chatId: turn.chatId,
              message: learnerMessage,
              // A resumed reply already named its section; cite for that one.
              ...(resumedSection?.kind === "section"
                ? { resumedSectionId: resumedSection.id }
                : {}),
            })
          : null
        // `Plan my lesson` carries the learner's pre-check answers, read from
        // the saved answers rather than trusted from the browser. A plan with
        // skimmed sections keeps them, so a rebuilt session knows what to cover.
        const planning =
          learnerMessage.trim() === TEACH_QUICK_REPLIES.precheckDone
        const precheck =
          teach && (planning || teach.plan?.some((entry) => entry.mode === "skim"))
            ? await client.query(api.teach.precheckResults, { chatId: turn.chatId })
            : undefined
        progress = createChatProgress(
          (reply, thought) =>
            client.mutation(saveWorkspaceProgress, {
              ...replyIds,
              reply,
              ...(thought ? { thought } : {}),
            }),
          turn.replyPrefix
        )
        send({
          type: "started",
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
        })
        if (turn.initialTitle !== undefined)
          titlePromise = nameChat(
            client,
            turn,
            turn.initialTitle,
            input.message,
            persistedAttachments.map((attachment) => attachment.label)
          )
        const { autonomy, additionalInstructions, workingProjectId, planFirst } =
          turnAgentSettings(
            input,
            await client.query(api.chatAgents.getSettings, {
              chatId: turn.chatId,
            }),
            Boolean(teach)
          )
        const { resetContext } = await client.mutation(
          api.chatAgents.configure,
          {
            chatId: turn.chatId,
            autonomy,
            additionalInstructions,
            ...(workingProjectId ? { workingProjectId } : {}),
            ...(input.planFirst === undefined
              ? {}
              : { planFirst: input.planFirst }),
          }
        )
        const workspaceDirectory = teach
          ? (await prepareProjectAgentWorkspace(teach.projectId))
              .projectDirectory
          : workingProjectId
            ? (await prepareProjectAgentWorkspace(workingProjectId))
                .projectDirectory
            : await chatWorkspaceDirectory(
                turn.workspaceFolderId ?? turn.chatId
              )
        const owners = {
          ...(ownerProjectId ? { ownerProjectId } : {}),
          chatId: turn.chatId,
        }
        await stageWorkspaceAttachments(
          client,
          workspaceDirectory,
          input.attachments,
          owners
        )
        if (turn.replayContext.attachments.length) {
          await stageWorkspaceAttachments(
            client,
            workspaceDirectory,
            turn.replayContext.attachments,
            owners
          )
        }
        const selection = savedChatReplySelection(configuredSelection, turn)
        if (input.spoken && !teach) await applySpokenModel(selection)
        const approvalPolicy = turnApprovalPolicy(
          Boolean(teach),
          autonomy,
          modelSettings,
          selection.providerId
        )
        agentSession = createChatAgentSession({
          client,
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          autonomy: approvalPolicy === "full-access" ? "full" : autonomy,
          approvalPolicy,
          signal: turnSignal,
          send,
        })
        if (
          !CHAT_PROVIDER_CAPABILITIES[
            selection.providerId
          ].sandboxModes.includes("workspace-write") &&
          autonomy === "project"
        ) {
          throw new CardChatError(
            "transport",
            "This provider has no workspace-only OS sandbox. Choose approval mode or full access."
          )
        }
        // What the tutor is asked this turn: a redo adds its steer.
        const teachMessage =
          turn.redo && input.redo
            ? teachRedoMessage(learnerMessage, input.redo.style)
            : (teach?.turnInstruction ?? turnInput.message)
        /** Builds this Teach turn's prompt; see `teachTurnPrompt`. */
        const teachPrompt = (
          includeContext: boolean,
          options: { afterCompaction?: boolean; message?: string } = {}
        ): string =>
          teachTurnPrompt(teach!, {
            message: options.message ?? teachMessage,
            includeContext,
            ...(options.afterCompaction ? { afterCompaction: true } : {}),
            history: turn.replayContext.messages,
            ...(precheck ? (planning ? { precheck } : { precheckContext: precheck }) : {}),
          })
        let replayPrompt: Promise<string> | undefined
        /** Rebuilds prior dialogue and attachments only when thread continuity is uncertain. */
        const promptWithReplay = (): Promise<string> => {
          if (teach) return Promise.resolve(teachPrompt(true))
          replayPrompt ??= (async () => {
            // A new session has not seen earlier turns' images.
            await appendReplayImages(
              client,
              turn.replayContext.attachments,
              {
                ...(ownerProjectId ? { ownerProjectId } : {}),
                ...(input.chatId ? { chatId: input.chatId } : {}),
              },
              native
            )
            return replayedChatPrompt(
              client,
              turnInput,
              turn.replayContext,
              projects,
              card
            )
          })()
          return replayPrompt
        }
        const features = providerThreadFeatures(selection.providerId)
        activity = createActivityLog(client, replyIds, send)
        events = createTurnEvents({
          client,
          reply: replyIds,
          providerId: selection.providerId,
          teach: Boolean(teach),
          redo: turn.redo,
          send,
          progress,
          activity,
        })
        const attempt = events.state
        const turnEvents = events
        /** Runs one attempt and records its identifiers before any streamed failure. */
        const runTurn = async (
          prompt: string,
          threadId?: string,
          attachments: readonly ProviderImageAttachment[] = native.images,
          around: {
            fork?: { sessionId: string; throughTurnId: string }
            compactFirst?: boolean
            compactedPrompt?: string
            rewindBeforeTurnId?: string
            /** Another provider's conversation, carried into a new session after a handoff. */
            seed?: PortableTranscript
          } = {}
        ): ReturnType<typeof runProviderTextTurn> => {
          turnEvents.startAttempt()
          const codexModelCatalog =
            selection.providerId === "codex"
              ? await getCodexModelCatalog({ requestTimeoutMs: 5_000 })
              : undefined
          return runProviderTextTurn(
            {
              providerId: selection.providerId,
              workspaceDirectory,
              prompt: input.spoken
                ? spokenPrompt(prompt, Boolean(teach), input.voiceNote)
                : prompt,
              ...(attachments.length ? { attachments } : {}),
              ...(threadId ? { threadId } : {}),
              ...(around.seed ? { seed: around.seed } : {}),
              model: selection.model,
              effort: selection.effort,
              sandbox: turnSandbox(
                Boolean(teach),
                selection.providerId,
                approvalPolicy,
                autonomy
              ),
              ...(teach
                ? teachTurnSettings(selection.providerId, workspaceDirectory)
                : {
                    developerInstructions: projectAgentInstructions(
                      workspaceDirectory,
                      additionalInstructions,
                      selection.providerId === "codex"
                    ),
                    approvalPolicy,
                  }),
              // The chat keeps its Plan first choice when it moves to a
              // provider without plan mode, so it applies again on return.
              ...(planFirst && features.planMode
                ? { mode: "plan" as const }
                : {}),
              signal: turnSignal,
              timeoutMs: WORKSPACE_CHAT_TIMEOUT_MS,
              ...(around.fork
                ? {
                    fork: {
                      threadId: around.fork.sessionId,
                      throughTurnId: around.fork.throughTurnId,
                    },
                  }
                : {}),
              ...(around.compactFirst ? { compactFirst: true } : {}),
              ...(around.compactedPrompt
                ? { compactedPrompt: around.compactedPrompt }
                : {}),
              ...(around.rewindBeforeTurnId
                ? { rewindBeforeTurnId: around.rewindBeforeTurnId }
                : {}),
              ...(teach && features.contextUsage
                ? { readContextUsage: true }
                : {}),
            },
            {
              ...(selection.providerId === "codex" && agentSession
                ? { codex: agentSession.codex }
                : {}),
              ...(codexModelCatalog ? { codexModelCatalog } : {}),
              onRequest: agentSession?.handleRequest,
              onEvent: turnEvents.onEvent,
            }
          )
        }
        // Retrieval follows each new question, including projects attached in
        // earlier turns whose Codex conversation does not need replay.
        const previousProjectIds = turn.replayContext.projectIds
          .filter(
            (projectId) => !projects.some((project) => project.id === projectId)
          )
          .slice(0, Math.max(0, 3 - projects.length))
        for (const projectId of previousProjectIds) {
          try {
            projects.push(
              ...(await client.query(getProjectContext, {
                projectIds: [projectId],
                question: retrievalQuestion || undefined,
              }))
            )
          } catch {
            // A removed historical project does not invalidate the conversation.
          }
        }
        // A branch copies its source's runtime session when it can; a reset
        // or a provider without forks replays the transcript instead.
        const forkSource = !resetContext && features.fork ? turn.fork : null
        // After a usage-limit handoff the new provider's session is seeded
        // with the old session's transcript, so the prompt needs no replay.
        // Teach rebuilds from its unit and plan instead, which a seed of its
        // first prompt (the whole unit) would only duplicate.
        const handoffSeed =
          turn.providerHandoff && !teach && !resetContext
            ? await readHandoffTranscript(turn.providerHandoff, workspaceDirectory)
            : undefined
        const replay =
          !handoffSeed &&
          ((turn.shouldReplayContext && !forkSource) || resetContext)
        // A long Teach session compacts before the turn, then restates the
        // unit material, outline, and plan the summary may have lost.
        const compactFirst =
          Boolean(teach) && !replay && features.compact && turn.context.compactFirst
        const restate =
          Boolean(teach) && !replay && !compactFirst && turn.context.restate
        const rewindBeforeTurnId =
          turn.redo && !replay && features.rewind
            ? turn.redo.beforeTurnId
            : undefined
        const initialPrompt = handoffSeed
          ? handoffPrompt(
              buildWorkspaceChatPrompt(turnInput, projects, card),
              providerLabel(turn.providerHandoff!.fromProviderId),
              turn.replyPrefix
            )
          : teach
            ? teachPrompt(replay || restate, { afterCompaction: restate })
            : replay
              ? await promptWithReplay()
              : buildWorkspaceChatPrompt(turnInput, projects, card)
        const citationProjectIds = [
          ...new Set(
            [
              ownerProjectId,
              ...input.projectIds,
              ...turn.replayContext.projectIds,
              card?.projectId,
            ].filter((id): id is Id<"projects"> => Boolean(id))
          ),
        ].slice(0, 3)
        const retrieved = await Promise.all(
          (teach ? [] : citationProjectIds).map((projectId) =>
            client.query(api.chatCitations.projectPassages, {
              projectId,
              question: retrievalQuestion,
            })
          )
        )
        const citations = await client.mutation(api.chatCitations.prepare, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          question: teach?.citationFocus || retrievalQuestion,
          chunkIds: teach
            ? teach.citationChunkIds
            : [
                ...new Set(
                  retrieved.flatMap((result) =>
                    result.results.map((item) => item.citation.chunkId)
                  )
                ),
              ].slice(0, 60),
        })
        const citationContext = citationPrompt(citations)
        /** Runs the reply's first attempt, falling back to replay when the saved session is gone. */
        const firstAttempt = async (): ReturnType<typeof runProviderTextTurn> => {
          try {
            return await runTurn(
              `${initialPrompt}\n\n${citationContext}`,
              resetContext ? undefined : (turn.providerSessionId ?? undefined),
              native.images,
              {
                ...(forkSource ? { fork: forkSource } : {}),
                ...(compactFirst
                  ? {
                      compactFirst: true,
                      compactedPrompt: `${teachPrompt(true, { afterCompaction: true })}\n\n${citationContext}`,
                    }
                  : {}),
                ...(rewindBeforeTurnId ? { rewindBeforeTurnId } : {}),
                ...(handoffSeed ? { seed: handoffSeed } : {}),
              }
            )
          } catch (error) {
            // A copy that failed, such as one cut at a turn ID saved by an
            // older runtime, replays the transcript instead without saying so.
            if (forkSource && !attempt.accepted) {
              console.warn("Workspace chat could not copy the branched session", {
                reason: error instanceof CardChatError ? error.reason : "unknown",
              })
              return runTurn(`${await promptWithReplay()}\n\n${citationContext}`)
            }
            if (
              !turn.providerSessionId ||
              attempt.accepted ||
              !(error instanceof CardChatError) ||
              error.reason !== "transport"
            )
              throw error
            console.warn(
              "Workspace chat could not resume its saved provider session",
              {
                reason: error instanceof CardChatError ? error.reason : "unknown",
              }
            )
            return runTurn(`${await promptWithReplay()}\n\n${citationContext}`)
          }
        }
        /** Reply text kept from an attempt that ran out of room. */
        let carriedText = ""
        let result
        try {
          result = await firstAttempt()
        } catch (error) {
          // A reply that ran out of room is finished after compacting, once.
          const threadId = attempt.threadId
          if (
            !(error instanceof CardChatError) ||
            error.reason !== "context-window" ||
            !features.compact ||
            !threadId
          )
            throw error
          console.warn("Workspace chat ran out of context; compacting to finish the reply")
          carriedText += attempt.text
          attempt.compactionOrigin = "overflow"
          const continuation = overflowContinuationMessage(
            teach ? teachMessage : turnInput.message,
            carriedText
          )
          result = await runTurn(continuation, threadId, [], {
            compactFirst: true,
            compactedPrompt: teach
              ? `${teachPrompt(true, { afterCompaction: true, message: continuation })}\n\n${citationContext}`
              : continuation,
          })
        }
        if (workingProjectId) {
          // The reply already exists at this point. Artifact listing is
          // bookkeeping, so an unreadable project folder must not discard it.
          try {
            const artifacts = await scanProjectArtifacts(workspaceDirectory)
            await client.mutation(api.projectAgents.syncArtifacts, {
              projectId: workingProjectId,
              artifacts,
            })
          } catch (error) {
            console.warn("Workspace chat could not sync project artifacts", {
              message: error instanceof Error ? error.message : "Unknown error",
            })
          }
        }
        await progress.finish()
        await activity.flush()
        await events.settle()
        const reply = combineWorkspaceChatContinuation(
          turn.replyPrefix,
          `${carriedText}${result.text}`
        )
        // Teach progress (section, plan) is saved before the chat goes idle,
        // so a `Next section` sent the moment it does sees where the lesson is.
        if (teach)
          await finishTeachTurn(client, {
            ...replyIds,
            teach,
            reply,
            planning,
            contextUsage: result.contextUsage,
            restated:
              (replay || restate || attempt.requestedCompacted) &&
              !attempt.runtimeCompacted,
          })
        await client.mutation(completeWorkspaceTurn, {
          ...replyIds,
          providerId: selection.providerId,
          providerSessionId: result.threadId,
          providerTurnId: result.turnId,
          ...(selection.providerId === "codex"
            ? {
                codexThreadId: result.threadId,
                codexTurnId: result.turnId,
              }
            : {}),
          reply,
          thought: result.thought,
          durationMs: result.durationMs,
        })
        send({
          type: "complete",
          chatId: turn.chatId,
          threadId: result.threadId,
          durationMs: result.durationMs,
        })
      } catch (error) {
        await events?.state.binding
        await progress?.finish().catch(() => undefined)
        await events?.settle()
        await activity?.flush()
        const failure = workspaceChatFailure(error, Boolean(activeTurn))
        const detail = workspaceChatFailureDetail(error)
        console.error("Workspace chat turn failed", {
          reason: failure.reason,
          message: detail ?? "Unknown error",
        })
        if (activeTurn)
          await convexClient()
            .mutation(failWorkspaceTurn, {
              chatId: activeTurn.chatId,
              messageId: activeTurn.assistantMessageId,
              error: failure.message,
              // Saved beside the recovery copy so a failed chat can be
              // diagnosed from its record, not only from server logs.
              reason: failure.reason,
              ...(detail ? { detail } : {}),
            })
            .catch(() => undefined)
        send({
          type: "error",
          message: failure.message,
        })
      } finally {
        unregisterRun?.()
        await agentSession?.close()
        if (titlePromise) {
          await Promise.race([
            titlePromise,
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]).catch(() => undefined)
        }
        if (!closed) controller.close()
        closed = true
      }
    },
    cancel() {
      deliveryCancelled = true
    },
  })
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
