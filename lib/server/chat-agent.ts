/**
 * Attaches folder instructions and bridges interactive runtime requests into a
 * persisted chat.
 *
 * Codex and Claude Code requests arrive as agent-engines request events; this
 * session shows each one in the chat composer, waits for the learner, and
 * answers it. Codex also gets Blitz's own question and checkpoint tools, and
 * the policy for the selected autonomy. OpenCode requests come through the ACP
 * handlers.
 */
import type { AiApprovalPolicy } from "../ai-model-settings.ts"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { AgentRequest, CodexToolCall } from "agent-engines"
import type { ConvexHttpClient } from "convex/browser"
import { api } from "../../convex/_generated/api.js"
import type { Id } from "../../convex/_generated/dataModel"
import {
  answerAgentRequest,
  codexAgentRequestTools,
  dynamicToolResponse,
  genericApprovalRequest,
  normalizeAgentRequest,
  normalizeDynamicToolCall,
  refuseAgentRequest,
  type AgentRequestSpec,
} from "./agent-request.ts"
import {
  projectAgentRuntimePolicy,
  type ProjectAgentAutonomy,
} from "./project-agent.ts"
import type { CodexTurnOverrides } from "./providers/run-text-turn.ts"
import type { EngineProviderId } from "./providers/engines.ts"
import type { ProviderApprovalDecision } from "./providers/types.ts"
import type { AcpRequestHandler } from "./providers/acp.ts"

/** Builds a turn-scoped approval bridge and Codex policy; callers close it on every exit path. */
export function createChatAgentSession(options: {
  client: ConvexHttpClient
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
  /** Provider setting for the chat approval mode, applied to start and resume. */
  approvalPolicy?: AiApprovalPolicy
  autonomy: ProjectAgentAutonomy
  signal: AbortSignal
  send: (event: unknown) => void
}) {
  const abort = new AbortController()
  const signal = AbortSignal.any([options.signal, abort.signal])
  const identity = { chatId: options.chatId, messageId: options.messageId }
  const runtime = projectAgentRuntimePolicy(options.autonomy)
  if (options.autonomy === "approval" && options.approvalPolicy)
    runtime.approvalPolicy =
      options.approvalPolicy === "full-access"
        ? "never"
        : options.approvalPolicy
  let queue: Promise<unknown> = Promise.resolve()

  /** Runs one review after any earlier one, so requests are shown one at a time. */
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * Shows one Codex or Claude Code request and answers it; grants never carry
   * into later turns. With approvals off, approvals are refused unseen.
   */
  function handleRequest(
    request: AgentRequest,
    providerId: EngineProviderId
  ): Promise<void> {
    return serialize(async () => {
      signal.throwIfAborted()
      const neverAsk =
        providerId === "codex"
          ? runtime.approvalPolicy === "never"
          : options.approvalPolicy === "never"
      const spec =
        request.kind === "approval" && neverAsk
          ? undefined
          : normalizeAgentRequest(
              request,
              providerId === "codex" ? "codex" : "claude"
            )
      if (!spec) return refuseAgentRequest(request)
      const result = await review({ ...spec, providerRequestId: request.id })
      await answerAgentRequest(request, spec, result)
    })
  }

  /** Answers one of Blitz's own Codex tools after the learner replies. */
  function handleToolCall(
    call: CodexToolCall
  ): Promise<{ text: string; success: boolean }> {
    return serialize(async () => {
      signal.throwIfAborted()
      const spec = normalizeDynamicToolCall(call)
      const result = await review({ ...spec, providerRequestId: call.callId })
      return dynamicToolResponse(spec, result.accepted, result.response)
    })
  }

  /** Persists one request and clears it after the user responds or the turn ends. */
  async function review(
    spec: AgentRequestSpec,
    reviewSignal = signal
  ): Promise<{ accepted: boolean; response?: string }> {
    const request = {
      id: randomUUID(),
      ...(spec.providerRequestId
        ? { providerRequestId: spec.providerRequestId }
        : {}),
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
        ...(request.providerRequestId
          ? { providerRequestId: request.providerRequestId }
          : {}),
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
        .mutation(api.chatAgents.clearApproval, {
          ...identity,
          approvalId: request.id,
        })
        .catch(() => undefined)
      options.send({ type: "agent-request-resolved", requestId: request.id })
    }
  }

  /** Serializes native provider requests through the same single-use chat approval panel. */
  function approveProvider(request: {
    requestId?: string | number
    method: string
    params: unknown
    signal?: AbortSignal
  }): Promise<ProviderApprovalDecision> {
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
        {
          ...genericApprovalRequest(request.method, details),
          ...(request.requestId === undefined ? {} : { providerRequestId: String(request.requestId) }),
        },
        request.signal ? AbortSignal.any([signal, request.signal]) : signal
      )
    })
    queue = operation.catch(() => undefined)
    return operation.catch(() => false)
  }

  /** Bridges verified ACP reverse requests through durable composer interactions. */
  const handleProviderRequest: AcpRequestHandler = async (request) => {
    const operation = queue.then(async () => {
      if (request.signal?.aborted || signal.aborted)
        return { outcome: { outcome: "cancelled" } }
      const details = JSON.stringify(request.params, null, 2)
      if (!details || details.length > 20_000)
        return { outcome: { outcome: "cancelled" } }
      const spec = genericApprovalRequest(request.method, details)
      const result = await review(
        { ...spec, providerRequestId: String(request.requestId) },
        request.signal ? AbortSignal.any([signal, request.signal]) : signal
      )
      if (!result.accepted) return { outcome: { outcome: "cancelled" } }
      let optionId: string | undefined
      try {
        const parsed = result.response ? JSON.parse(result.response) : undefined
        optionId =
          parsed && typeof parsed.optionId === "string"
            ? parsed.optionId
            : undefined
      } catch {
        optionId = undefined
      }
      return optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } }
    })
    queue = operation.catch(() => undefined)
    return operation.catch(() => ({ outcome: { outcome: "cancelled" } }))
  }

  /** Codex thread policy and Blitz's own tools for this chat's autonomy. */
  const codex: CodexTurnOverrides = {
    thread: {
      ...runtime,
      dynamicTools: codexAgentRequestTools(),
      config: { web_search: "live" },
    },
    onToolCall: handleToolCall,
  }

  /** Cancels pending waits and removes stale approval controls after success, failure, or disconnection. */
  async function close(): Promise<void> {
    abort.abort()
    await queue
    await options.client
      .mutation(api.chatAgents.clearApproval, identity)
      .catch(() => undefined)
  }
  return {
    codex,
    handleRequest,
    approveProvider,
    handleProviderRequest,
    close,
  }
}
