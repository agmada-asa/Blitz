/** Attaches folder instructions and bridges interactive runtime approvals into a persisted chat. */
import type { AiApprovalPolicy } from "../ai-model-settings.ts"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { ConvexHttpClient } from "convex/browser"
import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel"
import {
  CodexAppServerClient,
  type CodexApprovalResponse,
  type CodexServerRequest,
} from "./codex-app-server.ts"
import type { CardChatEvent, CardChatTransportFactory } from "./card-chat.ts"
import {
  projectAgentInstructions,
  projectAgentRuntimePolicy,
  type ProjectAgentAutonomy,
} from "./project-agent.ts"
import {
  approvalRecord,
  projectApprovalDetails,
  projectApprovalResponse,
  supportedProjectApproval,
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
    options.additionalInstructions
  )
  let queue: Promise<unknown> = Promise.resolve()

  /** Keeps simultaneous requests separate and never carries grants into later turns. */
  function approve(
    request: CodexServerRequest
  ): Promise<CodexApprovalResponse> {
    const operation = queue.then(async () => {
      signal.throwIfAborted()
      if (
        runtime.thread.approvalPolicy === "never" ||
        !supportedProjectApproval(request.method)
      )
        return projectApprovalResponse(request, false)
      const params = approvalRecord(request.params)
      const item =
        typeof params?.itemId === "string"
          ? items.get(params.itemId)
          : undefined
      // File changes must include reviewable diffs; an opaque grantRoot is insufficient.
      if (request.method === "item/fileChange/requestApproval" && !item)
        return projectApprovalResponse(request, false)
      return projectApprovalResponse(
        request,
        await review(request.method, projectApprovalDetails(request, item))
      )
    })
    queue = operation.catch(() => undefined)
    return operation
  }

  /** Persists one review and clears it on approval, rejection, timeout, or cancellation. */
  async function review(
    method: string,
    details: string,
    reviewSignal = signal
  ): Promise<boolean> {
    const approval = {
      id: randomUUID(),
      method,
      details,
      expiresAt: Date.now() + 300_000,
    }
    await options.client.mutation(api.chatAgents.requestApproval, {
      ...identity,
      approval,
    })
    options.send({
      type: "approval",
      ...identity,
      approval: { ...approval, status: "pending" },
    })
    try {
      while (!reviewSignal.aborted && Date.now() < approval.expiresAt) {
        const state = await options.client.query(
          api.chatAgents.getApproval,
          identity
        )
        if (!state.active || state.approval?.id !== approval.id) return false
        if (state.approval.status !== "pending")
          return state.approval.status === "approved"
        await delay(500, undefined, { signal: reviewSignal })
      }
      return false
    } finally {
      await options.client
        .mutation(api.chatAgents.clearApproval, identity)
        .catch(() => undefined)
      options.send({ type: "approval-resolved", approvalId: approval.id })
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
        request.method,
        details,
        request.signal ? AbortSignal.any([signal, request.signal]) : signal
      )
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
      webSearchMode: options.autonomy === "full" ? "live" : "disabled",
      approvalHandler: options.autonomy === "approval" ? approve : undefined,
    })
    return {
      startThread: (settings) =>
        client.startThread({
          ...settings,
          ...runtime.thread,
          developerInstructions: instructions,
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
