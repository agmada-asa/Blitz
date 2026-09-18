/** Streams general workspace chat turns through the selected Blitz provider. */

import { api } from "@/convex/_generated/api"
import { CHAT_PROVIDER_CAPABILITIES } from "@/lib/provider-capabilities"
import { citationPrompt } from "@/lib/citations"
import { createChatAgentSession } from "@/lib/server/chat-agent"
import {
  prepareProjectAgentWorkspace,
  projectAgentInstructions,
  scanProjectArtifacts,
} from "@/lib/server/project-agent"
import { ConvexHttpClient } from "convex/browser"
import { makeFunctionReference } from "convex/server"
import { copyFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import {
  readProjectFileBytes,
  resolveProjectFile,
} from "@/lib/server/project-files"
import { chatStorageId, safeSourceFilename } from "@/lib/server/source-files"
import type { Id } from "@/convex/_generated/dataModel"
import {
  resolveAiTaskSelection,
  resolveProviderApprovalPolicy,
  type AiProviderId,
} from "@/lib/ai-model-settings"
import { CardChatError } from "@/lib/server/card-chat"
import { createChatProgress } from "@/lib/server/chat-progress"
import {
  loadSavedAiModelSettings,
  SavedModelSettingsError,
} from "@/lib/server/ai-model-settings"
import { runProviderTextTurn } from "@/lib/server/providers/run-text-turn"
import { getCodexModelCatalog } from "@/lib/server/providers/codex-models"
import { providerCommand } from "@/lib/server/providers/registry"
import type { ProviderImageAttachment } from "@/lib/server/providers/types"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"
import { generateChatTitle } from "@/lib/server/chat-title"
import { registerChatRun } from "@/lib/server/chat-run-registry"
import {
  MAX_PROVIDER_ACTIVITY_EVENTS,
  normalizeProviderActivity,
  type ProviderActivityEvent,
} from "@/lib/provider-activity"
import {
  buildWorkspaceChatPrompt,
  combineWorkspaceChatContinuation,
  mergeWorkspaceChatReplay,
  parseWorkspaceChatRequest,
  type WorkspaceChatCardContext,
  type WorkspaceChatReplayContext,
  type WorkspaceChatProjectContext,
  type WorkspaceChatInlineAttachment,
} from "@/lib/server/workspace-chat"

/** Uses Node.js because each turn starts the selected local provider process. */
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
  ownerToken?: string
  kind: "card" | "project" | "file" | "link"
  label: string
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  projectId?: Id<"projects">
  itemId?: Id<"learningItems">
  text?: string
  url?: string
}

/** Annotation shape persisted alongside the user message that introduced it. */
type PersistedAnnotation = {
  id: string
  number?: number
  messageId: string
  selectedText: string
  note: string
  createdAt?: number
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
    steeringPrompt?: string
    providerId?: string
    providerInstanceId?: string
    providerModel?: string
    providerEffort?: string
    clientMessageId: string
    message: string
    attachments: PersistedAttachment[]
    annotations?: PersistedAnnotation[]
  },
  {
    chatId: Id<"workspaceChats">
    assistantMessageId: Id<"workspaceChatMessages">
    initialTitle?: string
    steeringPrompt?: string
    providerId: AiProviderId
    providerInstanceId?: string
    providerModel?: string
    providerEffort?: string
    providerSessionId: string | null
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
    providerId?: string
    providerInstanceId?: string
    providerSessionId?: string
    providerTurnId?: string
    codexThreadId?: string
    codexTurnId?: string
  },
  null
>("workspaceChats:bindTurn")

const saveWorkspaceProgress = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    reply: string
    thought?: string
  },
  null
>("workspaceChats:progress")

const saveWorkspaceProviderEvents = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    events: ProviderActivityEvent[]
  },
  null
>("workspaceChats:saveProviderEvents")

const completeWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    providerId?: string
    providerInstanceId?: string
    providerSessionId?: string
    providerTurnId?: string
    codexThreadId?: string
    codexTurnId?: string
    reply: string
    thought?: string
    durationMs?: number
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

/** Copies attached chat documents into the workspace under attachments/ and annotates them with paths. */
async function stageWorkspaceAttachments(
  client: ConvexHttpClient,
  workspaceDirectory: string,
  attachments: WorkspaceChatInlineAttachment[],
  options: {
    ownerProjectId?: Id<"projects">
    chatId?: Id<"workspaceChats">
  } = {}
): Promise<void> {
  const attachmentsDir = join(workspaceDirectory, "attachments")
  let dirCreated = false
  const seenFilenames = new Set<string>()

  for (const attachment of attachments) {
    if (!attachment.documentId) continue
    let document = await client.query(api.chatCitations.getDocument, {
      documentId: attachment.documentId,
      ...(options.ownerProjectId
        ? { projectId: options.ownerProjectId }
        : attachment.ownerToken
          ? { ownerToken: attachment.ownerToken }
          : options.chatId
            ? { chatId: options.chatId }
            : {}),
    })
    if (!document && attachment.ownerToken && options.chatId) {
      document = await client.query(api.chatCitations.getDocument, {
        documentId: attachment.documentId,
        chatId: options.chatId,
      })
    }
    if (!document) continue

    const storageId =
      document.projectId ??
      (document.ownerToken ? chatStorageId(document.ownerToken) : null)
    if (!storageId) continue

    try {
      const sourcePath = await resolveProjectFile(storageId, document.relativeKey)
      if (!dirCreated) {
        await mkdir(attachmentsDir, { recursive: true })
        dirCreated = true
      }
      let targetName = safeSourceFilename(document.filename)
      if (seenFilenames.has(targetName)) {
        const idPrefix = String(document._id).slice(-6)
        targetName = `${idPrefix}-${targetName}`
      }
      seenFilenames.add(targetName)
      const targetPath = join(attachmentsDir, targetName)

      if (resolve(sourcePath) !== resolve(targetPath)) {
        await copyFile(sourcePath, targetPath)
      }
      attachment.workspacePath = join("attachments", targetName)
      attachment.filePath = targetPath
    } catch {
      // Attachment copy failure does not block the chat turn.
    }
  }
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
  if (error instanceof SavedModelSettingsError)
    return { reason: "invalid-input", message: error.message }
  if (error instanceof CardChatError && error.reason === "invalid-input")
    return { reason: error.reason, message: error.message }
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
    message: `Blitz could not finish that reply. ${recovery}`,
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
      let providerEvents: ProviderActivityEvent[] = []
      let providerEventsTimer: ReturnType<typeof setTimeout> | undefined
      let providerEventsPending: Promise<void> | undefined
      let flushProviderEvents: (() => Promise<void>) | undefined
      let bindingPromise: Promise<unknown> | undefined
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
        const nativeImageAttachments: ProviderImageAttachment[] = []
        let nativeImageBytes = 0
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
          let document = await client.query(api.chatCitations.getDocument, {
            documentId: attachment.documentId,
            ...(ownerProjectId
              ? { projectId: ownerProjectId }
              : attachment.ownerToken
                ? { ownerToken: attachment.ownerToken }
                : input.chatId
                  ? { chatId: input.chatId }
                  : {}),
          })
          if (!document && attachment.ownerToken && input.chatId)
            document = await client.query(api.chatCitations.getDocument, {
              documentId: attachment.documentId,
              chatId: input.chatId,
            })
          if (!document)
            throw new Error(
              "Attached file was not found or is not owned by this chat"
            )
          attachment.label = document.filename
          if (
            document.mimeType === "image/png" ||
            document.mimeType === "image/jpeg" ||
            document.mimeType === "image/webp" ||
            document.mimeType === "image/gif"
          ) {
            attachment.mimeType = document.mimeType
            const storageId =
              document.projectId ??
              (document.ownerToken ? chatStorageId(document.ownerToken) : null)
            if (!storageId)
              throw new Error("Attached file storage is unavailable")
            const bytes = await readProjectFileBytes(
              storageId,
              document.relativeKey,
              5_000_000
            )
            nativeImageBytes += bytes.byteLength
            if (nativeImageBytes > 20_000_000)
              throw new Error("Attached images exceed the 20 MB chat limit.")
            nativeImageAttachments.push({
              type: "image",
              mimeType: document.mimeType,
              data: Buffer.from(bytes).toString("base64"),
              name: document.filename,
            })
          }
          attachment.text = document.text.slice(
            0,
            Math.min(24_000, attachmentBudget)
          )
          if (!attachment.text) {
            attachment.text = `[Attached file: ${document.filename}]`
          }
          attachmentBudget = Math.max(
            0,
            attachmentBudget - attachment.text.length
          )
        }
        const retrievalQuestion =
          input.message.trim() ||
          input.annotations
            ?.map((a) => `${a.note} ${a.selectedText}`)
            .join(" ")
            .slice(0, 500)
            .trim() ||
          ""
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
        const configuredSelection = resolveAiTaskSelection(
          modelSettings,
          "reply",
          {
            providerEnvironmentFallback: process.env.BLITZ_REPLY_PROVIDER,
            modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
            effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
          }
        )
        const turn = await client.mutation(startWorkspaceTurn, {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          providerId: configuredSelection.providerId,
          providerModel: configuredSelection.model,
          providerEffort: configuredSelection.effort,
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
        })
        activeTurn = {
          chatId: turn.chatId,
          assistantMessageId: turn.assistantMessageId,
        }
        unregisterRun = registerChatRun(
          turn.chatId,
          turn.assistantMessageId,
          turnAbort,
          Date.now() + WORKSPACE_CHAT_TIMEOUT_MS
        )
        // Recovery sessions need original image bytes because native blocks are
        // not retained by a provider when a fresh session is created.
        const nativeImageDocumentIds = new Set(
          input.attachments
            .map((attachment) => attachment.documentId)
            .filter((id): id is Id<"chatDocuments"> => Boolean(id))
        )
        /** Loads bounded historical images only when rebuilding a native session. */
        const appendReplayImages = async (): Promise<void> => {
          for (const attachment of turn.replayContext.attachments) {
            if (
              !attachment.documentId ||
              nativeImageDocumentIds.has(attachment.documentId) ||
              (attachment.mimeType !== "image/png" &&
                attachment.mimeType !== "image/jpeg" &&
                attachment.mimeType !== "image/webp" &&
                attachment.mimeType !== "image/gif")
            )
              continue
            const document = await client.query(api.chatCitations.getDocument, {
              documentId: attachment.documentId,
              ...(ownerProjectId
                ? { projectId: ownerProjectId }
                : input.chatId ? { chatId: input.chatId } : {}),
            })
            if (!document) continue
            const storageId =
              document.projectId ??
              (document.ownerToken ? chatStorageId(document.ownerToken) : null)
            if (!storageId) continue
            const bytes = await readProjectFileBytes(
              storageId,
              document.relativeKey,
              5_000_000
            )
            nativeImageBytes += bytes.byteLength
            if (nativeImageBytes > 20_000_000)
              throw new Error("Attached images exceed the 20 MB chat limit.")
            nativeImageDocumentIds.add(attachment.documentId)
            nativeImageAttachments.push({
              type: "image",
              mimeType: attachment.mimeType,
              data: Buffer.from(bytes).toString("base64"),
              name: document.filename,
            })
          }
        }
        /** Persists a coalesced snapshot of tool lifecycle records without blocking provider output. */
        const saveProviderEvents = async (): Promise<void> => {
          providerEventsTimer = undefined
          const snapshot = providerEvents.map((event) => ({ ...event }))
          providerEventsPending = client
            .mutation(saveWorkspaceProviderEvents, {
              chatId: turn.chatId,
              messageId: turn.assistantMessageId,
              events: snapshot,
            })
            .then(() => undefined)
            .catch(() => undefined)
            .finally(() => {
              providerEventsPending = undefined
              if (
                JSON.stringify(providerEvents) !== JSON.stringify(snapshot) &&
                !providerEventsTimer
              )
                providerEventsTimer = setTimeout(
                  () => void saveProviderEvents(),
                  250
                )
            })
          await providerEventsPending
        }
        flushProviderEvents = saveProviderEvents
        /** Queues one bounded activity snapshot and sends it to connected clients immediately. */
        const appendProviderEvent = (event: ProviderActivityEvent): void => {
          const existing = providerEvents.findIndex(
            (item) => item.id === event.id
          )
          if (existing >= 0) providerEvents[existing] = event
          else {
            providerEvents = [...providerEvents, event].slice(
              -MAX_PROVIDER_ACTIVITY_EVENTS
            )
          }
          send({ type: "activity", event })
          if (!providerEventsTimer && !providerEventsPending)
            providerEventsTimer = setTimeout(
              () => void saveProviderEvents(),
              250
            )
        }
        progress = createChatProgress(
          (reply, thought) =>
            client.mutation(saveWorkspaceProgress, {
              chatId: turn.chatId,
              messageId: turn.assistantMessageId,
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
        if (turn.initialTitle !== undefined) {
          const initialTitle = turn.initialTitle
          const contextLabels = persistedAttachments.map(
            (attachment) => attachment.label
          )
          titlePromise = (async () => {
            try {
              const succinctTitle = await generateChatTitle({
                message: input.message,
                contextLabels,
                providerId: turn.providerId,
                providerInstanceId: turn.providerInstanceId,
                fallbackTitle: initialTitle,
              })
              if (succinctTitle && succinctTitle !== initialTitle) {
                await client.mutation(api.workspaceChats.setGeneratedTitle, {
                  chatId: turn.chatId,
                  title: succinctTitle,
                  expectedCurrentTitle: initialTitle,
                })
              }
            } catch {
              // Chat retains initialTitle on any unexpected generation or update failure.
            }
          })()
        }
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
        await stageWorkspaceAttachments(
          client,
          workspaceDirectory,
          input.attachments,
          {
            ...(ownerProjectId ? { ownerProjectId } : {}),
            chatId: turn.chatId,
          }
        )
        if (turn.replayContext.attachments.length) {
          await stageWorkspaceAttachments(
            client,
            workspaceDirectory,
            turn.replayContext.attachments,
            {
              ...(ownerProjectId ? { ownerProjectId } : {}),
              chatId: turn.chatId,
            }
          )
        }
        const selection = {
          providerId: turn.providerId,
          model: turn.providerModel ?? configuredSelection.model,
          effort: turn.providerEffort ?? configuredSelection.effort,
        }
        const approvalPolicy =
          autonomy === "approval"
            ? resolveProviderApprovalPolicy(modelSettings, selection.providerId)
            : autonomy === "full"
              ? "full-access"
              : "never"
        {
          agentSession = createChatAgentSession({
            client,
            chatId: turn.chatId,
            messageId: turn.assistantMessageId,
            workspaceDirectory,
            autonomy: approvalPolicy === "full-access" ? "full" : autonomy,
            additionalInstructions,
            approvalPolicy,
            signal: turnSignal,
            send,
          })
        }
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
        let replayPrompt: Promise<string> | undefined
        /** Rebuilds prior dialogue and attachments only when thread continuity is uncertain. */
        const promptWithReplay = (): Promise<string> => {
          replayPrompt ??= (async () => {
            await appendReplayImages()
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
          threadId?: string,
          attachments: readonly ProviderImageAttachment[] = nativeImageAttachments
        ): ReturnType<typeof runProviderTextTurn> => {
          turnAccepted = false
          const codexModelCatalog =
            selection.providerId === "codex"
              ? await getCodexModelCatalog({
                  workspaceDirectory,
                  executable: providerCommand("codex").executable,
                  requestTimeoutMs: 5_000,
                })
              : undefined
          return runProviderTextTurn(
            {
              providerId: selection.providerId,
              workspaceDirectory,
              prompt,
              ...(attachments.length ? { attachments } : {}),
              ...(threadId ? { threadId } : {}),
              model: selection.model,
              effort: selection.effort,
              sandbox:
                selection.providerId === "codex"
                  ? approvalPolicy === "full-access" || autonomy === "full"
                    ? "danger-full-access"
                    : autonomy === "project"
                      ? "workspace-write"
                      : "read-only"
                  : undefined,
              developerInstructions: projectAgentInstructions(
                workspaceDirectory,
                additionalInstructions,
                selection.providerId === "codex"
              ),
              approvalPolicy,
              signal: turnSignal,
              timeoutMs: WORKSPACE_CHAT_TIMEOUT_MS,
            },
            {
              createCodexTransport:
                selection.providerId === "codex"
                  ? agentSession?.createTransport
                  : undefined,
              ...(codexModelCatalog ? { codexModelCatalog } : {}),
              approvalHandler: agentSession?.approveProvider,
              requestHandler: agentSession?.handleProviderRequest,
              onEvent: (event) => {
                agentSession?.observe(event)
                const activity = normalizeProviderActivity(event, providerEvents)
                if (activity) appendProviderEvent(activity)
                if (event.type === "turn-started") {
                  turnAccepted = true
                  bindingPromise = client
                    .mutation(bindWorkspaceTurn, {
                      chatId: turn.chatId,
                      messageId: turn.assistantMessageId,
                      providerId: selection.providerId,
                      providerSessionId: event.threadId,
                      providerTurnId: event.turnId,
                      ...(selection.providerId === "codex"
                        ? {
                            codexThreadId: event.threadId,
                            codexTurnId: event.turnId,
                          }
                        : {}),
                    })
                    .catch((bindingError: unknown) => {
                      console.error(
                        "Workspace chat could not save provider IDs",
                        {
                          message:
                            bindingError instanceof Error
                              ? bindingError.message
                              : "Unknown persistence error",
                        }
                      )
                    })
                  return
                }
                if (event.type === "thought-delta") {
                  progress?.appendThought(event.delta)
                  send({ type: "thought-delta", text: event.delta })
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
                question: retrievalQuestion || undefined,
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
              question: retrievalQuestion,
            })
          )
        )
        const citations = await client.mutation(api.chatCitations.prepare, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          question: retrievalQuestion,
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
            resetContext ? undefined : (turn.providerSessionId ?? undefined)
          )
        } catch (error) {
          if (
            !turn.providerSessionId ||
            turnAccepted ||
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
        if (providerEventsTimer) clearTimeout(providerEventsTimer)
        await providerEventsPending
        if (providerEvents.length) await saveProviderEvents()
        const reply = combineWorkspaceChatContinuation(
          turn.replyPrefix,
          result.text
        )
        await client.mutation(completeWorkspaceTurn, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
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
        await bindingPromise
        await progress?.finish().catch(() => undefined)
        if (providerEventsTimer) clearTimeout(providerEventsTimer)
        await providerEventsPending
        if (providerEvents.length) await flushProviderEvents?.()
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
