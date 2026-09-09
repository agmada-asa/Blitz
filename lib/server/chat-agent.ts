/** Attaches folder instructions and bridges interactive runtime requests into a persisted chat. */
import type { AiApprovalPolicy } from "../ai-model-settings.ts"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { ConvexHttpClient } from "convex/browser"
import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel"
import {
  CodexAppServerClient,
  type CodexServerRequest,
} from "./codex-app-server.ts"
import type { CardChatEvent, CardChatTransportFactory } from "./card-chat.ts"
import {
  codexAgentRequestTools,
  dynamicToolResponse,
  genericApprovalRequest,
  mcpElicitationResponse,
  normalizeCodexAgentRequest,
  userInputResponse,
  type AgentRequestSpec,
} from "./agent-request.ts"
import {
  projectAgentInstructions,
  projectAgentRuntimePolicy,
  type ProjectAgentAutonomy,
} from "./project-agent.ts"
import {
  approvalRecord,
  projectApprovalResponse,
} from "./project-agent-approval.ts"

/** Builds a turn-scoped transport and approval bridge; callers close it on every exit path. */
export function createChatAgentSession(options: {
  client: ConvexHttpClient
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
  workspaceDirectory: string
  /** Provider setting for the chat approval mode, applied to start and resume. */
  approvalPolicy?: AiApprovalPolicy
  autonomy: ProjectAgentAutonomy
  additionalInstructions: string
  signal: AbortSignal
  send: (event: unknown) => void
}) {
  const abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal])
  const identity = { chatId: options.chatId, messageId: options.messageId }
  const items = new Map<string, unknown>()
  const runtime = projectAgentRuntimePolicy(
    options.autonomy,
    options.workspaceDirectory
  )
  if (options.autonomy === "approval" && options.approvalPolicy)
    runtime.thread.approvalPolicy =
      options.approvalPolicy === "full-access"
        ? "never"
        : options.approvalPolicy
  const instructions = projectAgentInstructions(
    options.workspaceDirectory,
    options.additionalInstructions,
    true
  )
  let queue: Promise<unknown> = Promise.resolve()

  /** Keeps simultaneous requests separate and never carries grants into later turns. */
  function handleCodexRequest(request: CodexServerRequest): Promise<unknown> {
    const operation = queue.then(async () => {
      signal.throwIfAborted()
      const params = approvalRecord(request.params)
      const item =
        typeof params?.itemId === "string"
          ? items.get(params.itemId)
          : undefined
      const spec = normalizeCodexAgentRequest(request, item)
      if (!spec) return projectApprovalResponse(request, false)
      // File changes must include reviewable diffs; an opaque grantRoot is insufficient.
      if (request.method === "item/fileChange/requestApproval" && !item)
        return projectApprovalResponse(request, false)
      if (
        spec.kind === "approval" &&
        request.method !== "item/tool/call" &&
        runtime.thread.approvalPolicy === "never"
      )
        return projectApprovalResponse(request, false)
      const result = await review(spec)
      if (request.method === "item/tool/call")
        return dynamicToolResponse(spec, result.accepted, result.response)
      if (spec.kind === "question")
        return userInputResponse(spec.input, result.accepted, result.response)
      if (spec.kind === "form" || spec.kind === "url")
        return mcpElicitationResponse(spec, result.accepted, result.response)
      return projectApprovalResponse(request, result.accepted)
    })
    queue = operation.catch(() => undefined)
    return operation
  }

  /** Persists one request and clears it after the user responds or the turn ends. */
  async function review(
    spec: AgentRequestSpec,
    reviewSignal = signal
  ): Promise<{ accepted: boolean; response?: string }> {
    const request = {
      id: randomUUID(),
      method: spec.method,
      kind: spec.kind,
      title: spec.title,
      details: spec.details,
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(spec.input ? { input: JSON.stringify(spec.input) } : {}),
      expiresAt: Date.now() + 300_000,
    }
    await options.client.mutation(api.chatAgents.requestApproval, {
      ...identity,
      approval: {
        id: request.id,
        method: request.method,
        details: request.details,
        expiresAt: request.expiresAt,
        kind: request.kind,
        title: request.title,
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.input ? { input: request.input } : {}),
      },
    })
    options.send({
      type: "agent-request",
      ...identity,
      request: { ...request, status: "pending" },
    })
    try {
      while (!reviewSignal.aborted && Date.now() < request.expiresAt) {
        const state = await options.client.query(
          api.chatAgents.getApproval,
          identity
        )
        const approval = state.approval as
          | {
              id: string
              status: "pending" | "approved" | "denied"
              response?: string
            }
          | undefined
        if (!state.active || approval?.id !== request.id)
          return { accepted: false }
        if (approval.status !== "pending")
          return {
            accepted: approval.status === "approved",
            ...(approval.response ? { response: approval.response } : {}),
          }
        await delay(500, undefined, { signal: reviewSignal })
      }
      return { accepted: false }
    } finally {
      await options.client
        .mutation(api.chatAgents.clearApproval, identity)
        .catch(() => undefined)
      options.send({ type: "agent-request-resolved", requestId: request.id })
    }
  }

  /** Serializes native provider requests through the same single-use chat approval panel. */
  function approveProvider(request: {
    method: string
    params: unknown
    signal?: AbortSignal
  }): Promise<boolean> {
    const operation = queue.then(async () => {
      if (
        signal.aborted ||
        request.signal?.aborted ||
        options.approvalPolicy === "never"
      )
        return false
      const details = JSON.stringify(request.params, null, 2)
      if (!details || details.length > 20_000) return false
      return review(
        genericApprovalRequest(request.method, details),
        request.signal ? AbortSignal.any([signal, request.signal]) : signal
      ).then((result) => result.accepted)
    })
    queue = operation.catch(() => undefined)
    return operation
  }

  /** Collects bounded file diffs emitted before the associated approval request. */
  function observe(event: CardChatEvent): void {
    if (event.type !== "activity" || !("notification" in event)) return
    const item = approvalRecord(approvalRecord(event.notification.params)?.item)
    if (
      item?.type !== "fileChange" ||
      typeof item.id !== "string" ||
      JSON.stringify(item).length > 20_000
    )
      return
    if (items.size >= 25) items.delete(items.keys().next().value!)
    items.set(item.id, item)
  }

  /** Overrides every thread and turn policy while retaining the shared, tested lifecycle. */
  const createTransport: CardChatTransportFactory = async () => {
    const client = await CodexAppServerClient.connect({
      workspaceDirectory: options.workspaceDirectory,
      webSearchMode: "live",
      experimentalApi: true,
      requestHandler: handleCodexRequest,
    })
    return {
      startThread: (settings) =>
        client.startThread({
          ...settings,
          ...runtime.thread,
          developerInstructions: instructions,
          dynamicTools: codexAgentRequestTools(),
        }),
      resumeThread: (id, settings) =>
        client.resumeThread(id, {
          ...settings,
          ...runtime.thread,
          developerInstructions: instructions,
        }),
      startTurn: (id, settings) =>
        client.startTurn(id, { ...settings, sandboxPolicy: runtime.turn }),
      interruptTurn: (threadId, turnId) =>
        client.interruptTurn(threadId, turnId),
      onEvent: (listener) => client.onEvent(listener),
      close: () => client.close(),
    }
  }

  /** Cancels pending waits and removes stale approval controls after success, failure, or disconnection. */
  async function close(): Promise<void> {
    abort.abort()
    await queue
    await options.client
      .mutation(api.chatAgents.clearApproval, identity)
      .catch(() => undefined)
  }
  return { createTransport, observe, approveProvider, close }
}
