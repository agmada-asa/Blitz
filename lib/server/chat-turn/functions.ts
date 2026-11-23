/**
 * The Convex functions a workspace chat turn calls by name, with the
 * argument and result shapes the chat route relies on.
 */

import { makeFunctionReference, type FunctionReturnType } from "convex/server"

import type { Id } from "../../../convex/_generated/dataModel.js"
import type { AiProviderId } from "../../ai-model-settings.ts"
import type { ProviderActivityEvent } from "../../provider-activity.ts"
import type { TeachRedoStyle } from "../../teach.ts"
import type { TurnNotice } from "../../turn-notices.ts"
import type { CardChatResult } from "../card-chat.ts"
import type {
  WorkspaceChatCardContext,
  WorkspaceChatProjectContext,
  WorkspaceChatReplayContext,
} from "../workspace-chat.ts"

/** Attachment shape persisted alongside the turn that introduced it. */
export type PersistedAttachment = {
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
export type PersistedAnnotation = {
  id: string
  number?: number
  messageId: string
  selectedText: string
  note: string
  createdAt?: number
}

/** Attached projects' sources, ranked against the question when one is given. */
export const getProjectContext = makeFunctionReference<
  "query",
  { projectIds: Id<"projects">[]; question?: string },
  WorkspaceChatProjectContext[]
>("chatContext:getProjects")

/** An attached study card and its source context. */
export const getCardContext = makeFunctionReference<
  "query",
  { projectId: Id<"projects">; itemId: Id<"learningItems"> },
  WorkspaceChatCardContext
>("chatContext:getCard")

/** Saves the learner's message and an empty reply, and says how to run the turn. */
export const startWorkspaceTurn = makeFunctionReference<
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
    redoOf?: Id<"workspaceChatMessages">
    redoStyle?: TeachRedoStyle
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
    /** Chat whose folder the agent works in; null for the chat's own. */
    workspaceFolderId: string | null
    /** Runtime session a branch copies on this first turn, when it can. */
    fork: { sessionId: string; throughTurnId: string } | null
    /** Whether a Teach turn compacts first and restates its context. */
    context: { compactFirst: boolean; restate: boolean }
    /** The reply a redo replaces, its turn, and the request it answered. */
    redo: {
      beforeTurnId: string
      replacedMessageIds: Id<"workspaceChatMessages">[]
      originalMessage: string
      /** What the tutor is asked again, when it differs from the learner's request. */
      tutorMessage?: string
    } | null
    /** Provider and session to carry over after a usage-limit handoff. */
    providerHandoff: { fromProviderId: string; fromSessionId?: string } | null
    /**
     * The request a continued reply answers, sent again in place of the
     * continue instruction because the reply stopped before any text.
     */
    resentMessage?: string
    replyPrefix: string
    replayContext: WorkspaceChatReplayContext
  }
>("workspaceChats:startTurn")

/** A turn as `startWorkspaceTurn` describes it. */
export type StartedTurn = FunctionReturnType<typeof startWorkspaceTurn>

/** Saves the runtime session and turn a reply belongs to as soon as the runtime accepts it. */
export const bindWorkspaceTurn = makeFunctionReference<
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

/** Saves the reply and working notes streamed so far. */
export const saveWorkspaceProgress = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    reply: string
    thought?: string
  },
  null
>("workspaceChats:progress")

/** Saves the reply's tool activity. */
export const saveWorkspaceProviderEvents = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    events: ProviderActivityEvent[]
  },
  null
>("workspaceChats:saveProviderEvents")

/** Saves the finished reply. */
export const completeWorkspaceTurn = makeFunctionReference<
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

/** Marks the reply failed, with recovery copy and the reason. */
export const failWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    error: string
    reason?: string
    detail?: string
  },
  null
>("workspaceChats:fail")

/** Saves a refusal, denied tool, or safety notice beside the reply. */
export const addTurnNotice = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    notice: TurnNotice
  },
  null
>("workspaceChats:addNotice")

/** Removes a redone reply and its request once the runtime has dropped their turn. */
export const dropReplacedMessages = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    activeMessageId: Id<"workspaceChatMessages">
    messageIds: Id<"workspaceChatMessages">[]
  },
  null
>("workspaceChats:dropReplacedMessages")

/** Records a Teach session's compaction. */
export const recordCompaction = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    origin: "auto" | "overflow" | "runtime"
    beforeTokens?: number
  },
  null
>("workspaceChats:recordCompaction")

/** Saves how full a Teach session's context is and whether its material was restated. */
export const finishTurnContext = makeFunctionReference<
  "mutation",
  {
    chatId: Id<"workspaceChats">
    messageId: Id<"workspaceChatMessages">
    usage?: NonNullable<CardChatResult["contextUsage"]> & { updatedAt: number }
    restated: boolean
    updateDelivered?: boolean
  },
  null
>("workspaceChats:finishTurnContext")
