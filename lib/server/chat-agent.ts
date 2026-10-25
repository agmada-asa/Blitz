/**
 * Attaches folder instructions and bridges interactive runtime requests into a
 * persisted chat.
 *
 * Codex, Claude Code and OpenCode requests arrive as agent-engines request
 * events; this session shows each one in the chat composer, waits for the
 * learner, and answers it. Codex also gets Blitz's own question and checkpoint
 * tools, and the policy for the selected autonomy.
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
import type { TurnProviderId } from "./providers/engine-turn.ts"

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
   * Shows one provider request and answers it; grants never carry into later
   * turns. With approvals off, approvals are refused unseen.
   */
  function handleRequest(
    request: AgentRequest,
    providerId: TurnProviderId
  ): Promise<void> {
    return serialize(async () => {
      signal.throwIfAborted()
      const neverAsk =
        providerId === "codex"
          ? runtime.approvalPolicy === "never"
          : options.approvalPolicy === "never"
      // A plan is always shown: the learner asked for it with Plan first.
      const spec =
        request.kind === "approval" && request.action !== "plan" && neverAsk
          ? undefined
          : normalizeAgentRequest(
              request,
              providerId === "claude-code" ? "claude" : providerId
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
    close,
  }
}
