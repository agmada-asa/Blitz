/** Streams general workspace chat turns from the local Codex app-server. */

import { ConvexHttpClient } from "convex/browser"
import { makeFunctionReference } from "convex/server"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { Id } from "@/convex/_generated/dataModel"
import { resolveAiModel } from "@/lib/ai-model-settings"
import { runCodexTextTurn } from "@/lib/server/card-chat"
import { createChatProgress } from "@/lib/server/chat-progress"
import { loadSavedAiModelSettings } from "@/lib/server/ai-model-settings"
import {
  buildWorkspaceChatPrompt,
  parseWorkspaceChatRequest,
  type WorkspaceChatProjectContext,
} from "@/lib/server/workspace-chat"

/** Uses Node.js because each turn starts the local Codex process. */
export const runtime = "nodejs"
/** Allows the local turn to use the same bounded deadline as card chat. */
export const maxDuration = 75

const getProjectContext = makeFunctionReference<
  "query",
  { projectIds: Id<"projects">[] },
  WorkspaceChatProjectContext[]
>("chatContext:getProjects")

/** Attachment shape persisted alongside the turn that introduced it. */
type PersistedAttachment = {
  kind: "project" | "file" | "link"
  label: string
  projectId?: Id<"projects">
  text?: string
  url?: string
}

const startWorkspaceTurn = makeFunctionReference<
  "mutation",
  {
    chatId?: Id<"workspaceChats">
    clientMessageId: string
    message: string
    attachments: PersistedAttachment[]
  },
  {
    chatId: Id<"workspaceChats">
    assistantMessageId: Id<"workspaceChatMessages">
    codexThreadId: string | null
  }
>("workspaceChats:startTurn")

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
async function chatWorkspaceDirectory(): Promise<string> {
  const directory =
    process.env.BLITZ_CODEX_WORKSPACE?.trim() ||
    join(homedir(), ".local", "share", "blitz", "codex-workspace")
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

/** Starts or resumes one read-only Codex conversation with optional source context. */
export async function POST(request: Request): Promise<Response> {
  let input
  try {
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      let activeTurn:
        | {
            chatId: Id<"workspaceChats">
            assistantMessageId: Id<"workspaceChatMessages">
          }
        | undefined
      let progress: ReturnType<typeof createChatProgress> | undefined
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
        const projects = input.projectIds.length
          ? await client.query(getProjectContext, {
              projectIds: input.projectIds,
            })
          : []
        const persistedAttachments: PersistedAttachment[] = [
          ...projects.map((project) => ({
            kind: "project" as const,
            label: project.title,
            projectId: project.id,
          })),
          ...input.attachments,
        ]
        const turn = await client.mutation(startWorkspaceTurn, {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          clientMessageId: input.clientMessageId,
          message: input.message,
          attachments: persistedAttachments,
        })
        activeTurn = {
          chatId: turn.chatId,
          assistantMessageId: turn.assistantMessageId,
        }
        progress = createChatProgress((reply) =>
          client.mutation(saveWorkspaceProgress, {
            chatId: turn.chatId,
            messageId: turn.assistantMessageId,
            reply,
          })
        )
        send({ type: "started", chatId: turn.chatId })
        const workspaceDirectory = await chatWorkspaceDirectory()
        const modelSettings = await loadSavedAiModelSettings(client)
        const result = await runCodexTextTurn(
          {
            workspaceDirectory,
            prompt: buildWorkspaceChatPrompt(input, projects),
            ...(turn.codexThreadId ? { threadId: turn.codexThreadId } : {}),
            model: resolveAiModel(
              modelSettings,
              "replyModel",
              process.env.BLITZ_CODEX_MODEL
            ),
            ...(process.env.BLITZ_CODEX_EFFORT
              ? { effort: process.env.BLITZ_CODEX_EFFORT }
              : {}),
            signal: request.signal,
          },
          {
            onEvent: (event) => {
              if (event.type === "text-delta") {
                progress?.append(event.delta)
                send({ type: "delta", text: event.delta })
              }
            },
          }
        )
        await progress.finish()
        await client.mutation(completeWorkspaceTurn, {
          chatId: turn.chatId,
          messageId: turn.assistantMessageId,
          codexThreadId: result.threadId,
          codexTurnId: result.turnId,
          reply: result.text,
        })
        send({
          type: "complete",
          chatId: turn.chatId,
          threadId: result.threadId,
        })
      } catch {
        await progress?.finish().catch(() => undefined)
        if (activeTurn)
          await convexClient()
            .mutation(failWorkspaceTurn, {
              chatId: activeTurn.chatId,
              messageId: activeTurn.assistantMessageId,
              error: "Codex could not finish that reply.",
            })
            .catch(() => undefined)
        send({
          type: "error",
          message:
            "Codex could not finish that reply. Check the local worker setup and try again.",
        })
      } finally {
        if (!closed) controller.close()
        closed = true
      }
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
