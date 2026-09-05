/** Streams general workspace chat turns from the local Codex app-server. */

import { api } from "@/convex/_generated/api"
import { citationPrompt } from "@/lib/citations"
import { createChatAgentSession } from "@/lib/server/chat-agent"
import {
  prepareProjectAgentWorkspace,
  scanProjectArtifacts,
} from "@/lib/server/project-agent"
import { ConvexHttpClient } from "convex/browser"
import { makeFunctionReference } from "convex/server"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Id } from "@/convex/_generated/dataModel"
import {
  resolveAiModel,
  resolveAiReasoningEffort,
} from "@/lib/ai-model-settings"
import { CardChatError, runCodexTextTurn } from "@/lib/server/card-chat"
import { createChatProgress } from "@/lib/server/chat-progress"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import {
  buildWorkspaceChatPrompt,
  combineWorkspaceChatContinuation,
  mergeWorkspaceChatReplay,
  parseWorkspaceChatRequest,
  type WorkspaceChatCardContext,
  type WorkspaceChatReplayContext,
  type WorkspaceChatProjectContext,
} from "@/lib/server/workspace-chat"

/** Uses Node.js because each turn starts the local Codex process. */
export const runtime = "nodejs"
/** Leaves cleanup time beyond the workspace chat's ten-minute turn and approval deadline. */
export const maxDuration = 620

/** Source lookups often need longer than the card-chat default deadline. */
const WORKSPACE_CHAT_TIMEOUT_MS = 600_000

const getProjectContext = makeFunctionReference<
  "query",
  { projectIds: Id<"projects">[]; question?: string },
  WorkspaceChatProjectContext[]
>("chatContext:getProjects")

/** Attachment shape persisted alongside the turn that introduced it. */
type PersistedAttachment = {
  documentId?: Id<"chatDocuments">
  kind: "card" | "project" | "file" | "link"
  label: string
  projectId?: Id<"projects">
  itemId?: Id<"learningItems">
  text?: string
  url?: string
}

const getCardContext = makeFunctionReference<
  "query",
  { projectId: Id<"projects">; itemId: Id<"learningItems"> },
  WorkspaceChatCardContext
>("chatContext:getCard")

const startWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId?: Id<"workspaceChats">
    projectId?: Id<"projects">
    continuationOf?: Id<"workspaceChatMessages">
    clientMessageId: string
    message: string
    attachments: PersistedAttachment[]
  },
  {
    chatId: Id<"workspaceChats">
    assistantMessageId: Id<"workspaceChatMessages">
    codexThreadId: string | null
    shouldReplayContext: boolean
    replyPrefix: string
    replayContext: WorkspaceChatReplayContext
  }
>("workspaceChats:startTurn")

const bindWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    codexThreadId: string
    codexTurnId: string
  },
  null
>("workspaceChats:bindTurn")

const saveWorkspaceProgress = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    reply: string
  },
  null
>("workspaceChats:progress")

const completeWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    codexThreadId: string
    codexTurnId: string
    reply: string
  },
  null
>("workspaceChats:complete")

const failWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    error: string
  },
  null
>("workspaceChats:fail")

/** Creates a server-side Convex client for resolving attached project context. */
function convexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new Error("Project context is unavailable")
  return new ConvexHttpClient(endpoint)
}

/** Resolves and creates the dedicated local folder used for general chat turns. */
async function chatWorkspaceDirectory(chatId: string): Promise<string> {
  const directory = join(
    process.env.BLITZ_CODEX_WORKSPACE?.trim() ||
      join(homedir(), ".local", "share", "blitz", "codex-workspace"),
    chatId
  )
  if (!isAbsolute(directory))
    throw new Error("Chat workspace must be an absolute path")
  await mkdir(directory, { recursive: true })
  return directory
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

/** Returns recovery copy and a stable diagnostic reason for one failed turn. */
function workspaceChatFailure(
  error: unknown,
  contextSaved: boolean
): {
  reason: string
  message: string
} {
  const recovery = contextSaved
    ? "Your chat context is saved, so try again."
    : "Try again."
  if (error instanceof CardChatError && error.reason === "timeout")
    return {
      reason: error.reason,
      message: `That reply took too long. ${recovery}`,
    }
  if (error instanceof CardChatError && error.reason === "aborted")
    return {
      reason: error.reason,
      message: `That reply was interrupted. ${recovery}`,
    }
  return {
    reason: error instanceof CardChatError ? error.reason : "unknown",
    message: `Codex could not finish that reply. ${recovery}`,
  }
}

/** Starts or resumes one read-only Codex conversation with optional source context. */
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
    request.signal,
    turnAbort.signal,
    AbortSignal.timeout(WORKSPACE_CHAT_TIMEOUT_MS),
  ])
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
      let bindingPromise: Promise<unknown> | undefined
      /** Writes one event while tolerating a browser that has left the page. */
      const send = (value: unknown): void => {
        if (closed) return
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
        let attachmentBudget = Math.max(
          0,
          96_000 -
            input.attachments.reduce(
              (sum, attachment) => sum + attachment.text.length,
              0
            )
        )
        for (const attachment of input.attachments) {
          if (!attachment.documentId) continue
          if (!ownerProjectId) throw new Error("Chat project was not found")
          const document = await client.query(api.chatCitations.getDocument, {
            projectId: ownerProjectId,
            documentId: attachment.documentId,
          })
          if (!document)
            throw new Error("Attached file was not found in this project")
          attachment.label = document.filename
          attachment.text = document.text.slice(
            0,
            Math.min(24_000, attachmentBudget)
          )
          if (!attachment.text)
            throw new Error("Remove a file or link before adding another.")
          attachmentBudget -= attachment.text.length
        }
        const projects = input.projectIds.length
          ? await client.query(getProjectContext, {
              projectIds: input.projectIds,
              question: input.message,
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
        const turn = await client.mutation(startWorkspaceTurn, {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.continuationOf
            ? { continuationOf: input.continuationOf }
            : {}),
          clientMessageId: input.clientMessageId,
          message: input.message,
          attachments: persistedAttachments,
        })
        activeTurn = {
          chatId: turn.chatId,
          assistantMessageId: turn.assistantMessageId,
        }
        progress = createChatProgress(
          (reply) =>
            client.mutation(saveWorkspaceProgress, {
              chatId: turn.chatId,
              messageId: turn.assistantMessageId,
              reply,
            }),
          turn.replyPrefix
        )
        send({
          type: "started",
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
        })
        const savedAgentSettings = await client.query(
          api.chatAgents.getSettings,
          { chatId: turn.chatId }
        )
        const autonomy = input.autonomy ?? savedAgentSettings.autonomy
        const additionalInstructions =
          input.additionalInstructions ??
          savedAgentSettings.additionalInstructions
        const workingProjectId =
          input.autonomy === undefined
            ? savedAgentSettings.workingProjectId
            : input.workingProjectId
        const { resetContext } = await client.mutation(
          api.chatAgents.configure,
          {
            chatId: turn.chatId,
            autonomy,
            additionalInstructions,
            ...(workingProjectId ? { workingProjectId } : {}),
          }
        )
        const workspaceDirectory = workingProjectId
          ? (await prepareProjectAgentWorkspace(workingProjectId))
              .projectDirectory
          : await chatWorkspaceDirectory(turn.chatId)
        agentSession = createChatAgentSession({
          client,
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          workspaceDirectory,
          autonomy,
          additionalInstructions,
          signal: turnSignal,
          send,
        })
        const modelSettings = await loadSavedAiModelSettings(client)
        let replayPrompt: Promise<string> | undefined
        /** Rebuilds prior dialogue and attachments only when thread continuity is uncertain. */
        const promptWithReplay = (): Promise<string> => {
          replayPrompt ??= (async () => {
            const merged = mergeWorkspaceChatReplay(input, turn.replayContext)
            const currentProjects = new Map(
              projects.map((project) => [project.id, project] as const)
            )
            const missingProjectIds = merged.request.projectIds.filter(
              (projectId) => !currentProjects.has(projectId)
            )
            const recoveredProjects = await Promise.all(
              missingProjectIds.map(async (projectId) => {
                try {
                  return (
                    await client.query(getProjectContext, {
                      projectIds: [projectId],
                      question: input.message,
                    })
                  )[0]
                } catch {
                  return undefined
                }
              })
            )
            for (const project of recoveredProjects)
              if (project) currentProjects.set(project.id, project)
            let recoveredCard = card
            if (!recoveredCard && merged.card) {
              try {
                recoveredCard = await client.query(getCardContext, merged.card)
              } catch {
                // Deleted or unprepared historical cards cannot block recovery.
              }
            }
            return buildWorkspaceChatPrompt(
              merged.request,
              merged.request.projectIds
                .map((projectId) => currentProjects.get(projectId))
                .filter(
                  (project): project is WorkspaceChatProjectContext =>
                    project !== undefined
                ),
              recoveredCard,
              merged.history
            )
          })()
          return replayPrompt
        }
        let turnAccepted = false
        /** Runs one attempt and records its identifiers before any streamed failure. */
        const runTurn = async (
          prompt: string,
          threadId?: string
        ): ReturnType<typeof runCodexTextTurn> => {
          turnAccepted = false
          return runCodexTextTurn(
            {
              workspaceDirectory,
              prompt,
              ...(threadId ? { threadId } : {}),
              model: resolveAiModel(
                modelSettings,
                "replyModel",
                process.env.BLITZ_CODEX_MODEL
              ),
              effort: resolveAiReasoningEffort(
                modelSettings,
                "replyEffort",
                process.env.BLITZ_CODEX_EFFORT
              ),
              signal: turnSignal,
              timeoutMs: WORKSPACE_CHAT_TIMEOUT_MS,
            },
            {
              createTransport: agentSession!.createTransport,
              onEvent: (event) => {
                agentSession?.observe(event)
                if (event.type === "turn-started") {
                  turnAccepted = true
                  bindingPromise = client
                    .mutation(bindWorkspaceTurn, {
                      chatId: turn.chatId,
                      messageId: turn.assistantMessageId,
                      codexThreadId: event.threadId,
                      codexTurnId: event.turnId,
                    })
                    .catch((bindingError: unknown) => {
                      console.error("Workspace chat could not save Codex IDs", {
                        message:
                          bindingError instanceof Error
                            ? bindingError.message
                            : "Unknown persistence error",
                      })
                    })
                  return
                }
                if (event.type === "text-delta") {
                  progress?.append(event.delta)
                  send({ type: "delta", text: event.delta })
                }
              },
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
                question: input.message,
              }))
            )
          } catch {
            // A removed historical project does not invalidate the conversation.
          }
        }
        const initialPrompt =
          turn.shouldReplayContext || resetContext
            ? await promptWithReplay()
            : buildWorkspaceChatPrompt(input, projects, card)
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
          citationProjectIds.map((projectId) =>
            client.query(api.chatCitations.projectPassages, {
              projectId,
              question: input.message,
            })
          )
        )
        const citations = await client.mutation(api.chatCitations.prepare, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          question: input.message,
          chunkIds: [
            ...new Set(
              retrieved.flatMap((result) =>
                result.results.map((item) => item.citation.chunkId)
              )
            ),
          ].slice(0, 60),
        })
        const citationContext = citationPrompt(citations)
        let result
        try {
          result = await runTurn(
            `${initialPrompt}\n\n${citationContext}`,
            resetContext ? undefined : (turn.codexThreadId ?? undefined)
          )
        } catch (error) {
          if (
            !turn.codexThreadId ||
            turnAccepted ||
            !(error instanceof CardChatError) ||
            error.reason !== "transport"
          )
            throw error
          console.warn(
            "Workspace chat could not resume its saved Codex thread",
            {
              reason: error instanceof CardChatError ? error.reason : "unknown",
            }
          )
          result = await runTurn(
            `${await promptWithReplay()}\n\n${citationContext}`
          )
        }
        if (workingProjectId) {
          const artifacts = await scanProjectArtifacts(workspaceDirectory)
          await client.mutation(api.projectAgents.syncArtifacts, {
            projectId: workingProjectId,
            artifacts,
          })
        }
        await progress.finish()
        const reply = combineWorkspaceChatContinuation(
          turn.replyPrefix,
          result.text
        )
        await client.mutation(completeWorkspaceTurn, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          reply,
        })
        send({
          type: "complete",
          chatId: turn.chatId,
          threadId: result.threadId,
        })
      } catch (error) {
        await bindingPromise
        await progress?.finish().catch(() => undefined)
        const failure = workspaceChatFailure(error, Boolean(activeTurn))
        console.error("Workspace chat turn failed", {
          reason: failure.reason,
          message: error instanceof Error ? error.message : "Unknown error",
        })
        if (activeTurn)
          await convexClient()
            .mutation(failWorkspaceTurn, {
              chatId: activeTurn.chatId,
              messageId: activeTurn.assistantMessageId,
              error: failure.message,
            })
            .catch(() => undefined)
        send({
          type: "error",
          message: failure.message,
        })
      } finally {
        turnAbort.abort()
        await agentSession?.close()
        if (!closed) controller.close()
        closed = true
      }
    },
    cancel() {
      turnAbort.abort()
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
