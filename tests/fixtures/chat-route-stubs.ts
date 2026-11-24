/**
 * Stand-ins for the services the workspace chat route reaches beyond its own
 * logic: the Convex database, the AI provider, title generation, project
 * folders, stored files, and the question bank. `chat-route.test.ts` loads the
 * real route with these in place of its imports, so a test can run whole chat
 * turns without a database, a runtime process, or a model.
 *
 * Every stand-in reads and records through `harness`, which a test resets
 * before each turn with `resetChatRouteHarness`.
 */

import { getFunctionName, type FunctionReference } from "convex/server"
import { join } from "node:path"

import type { CardChatResult } from "../../lib/server/card-chat.ts"
import type {
  ProviderTextTurnOptions,
  RunProviderTextTurnRequest,
} from "../../lib/server/providers/run-text-turn.ts"

/** One Convex call the route made. */
export type ConvexCall = {
  kind: "query" | "mutation"
  name: string
  args: Record<string, unknown>
}

/** Answers one Convex function, by its `module:function` name. */
export type ConvexHandler = (args: Record<string, unknown>) => unknown

/** Plays one provider attempt: emit events through `options.onEvent`, then return or throw. */
export type ProviderScript = (
  request: RunProviderTextTurnRequest,
  options: ProviderTextTurnOptions
) => Promise<CardChatResult>

/** Everything the stand-ins answer with and record. */
export type ChatRouteHarness = {
  calls: ConvexCall[]
  handlers: Record<string, ConvexHandler>
  /** Played in order, one per provider attempt; the last repeats. */
  attempts: ProviderScript[]
  requests: RunProviderTextTurnRequest[]
  agentSessions: Array<Record<string, unknown>>
  titleRequests: Array<Record<string, unknown>>
  title: string | undefined
  questionBanks: string[]
  /** Stored file bytes by `storageId/relativeKey`. */
  files: Map<string, Uint8Array>
  /** Absolute path each stored file resolves to, by `storageId/relativeKey`. */
  filePaths: Map<string, string>
  /** Root for project folders the route asks for. */
  projectsDirectory: string
  codexModels: Array<{ id: string; reasoningEfforts?: string[] }>
  /** Failure of the initial catalogue probe, when the turn should retry it. */
  codexCatalogError?: Error
}

/** The live harness; replaced by `resetChatRouteHarness`. */
export let harness: ChatRouteHarness = emptyHarness("")

/** Builds a harness with no scripted answers. */
function emptyHarness(projectsDirectory: string): ChatRouteHarness {
  return {
    calls: [],
    handlers: {},
    attempts: [],
    requests: [],
    agentSessions: [],
    titleRequests: [],
    title: undefined,
    questionBanks: [],
    files: new Map(),
    filePaths: new Map(),
    projectsDirectory,
    codexModels: [],
  }
}

/**
 * Starts a fresh harness for one test.
 *
 * @param projectsDirectory - Where project folders are placed.
 * @returns The new harness.
 */
export function resetChatRouteHarness(
  projectsDirectory: string
): ChatRouteHarness {
  harness = emptyHarness(projectsDirectory)
  return harness
}

/** Records a Convex call and answers it from the harness. */
async function answer(
  kind: ConvexCall["kind"],
  reference: FunctionReference<"query" | "mutation">,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const name = getFunctionName(reference)
  harness.calls.push({ kind, name, args })
  const handler = harness.handlers[name]
  return handler ? handler(args) : null
}

/** Replaces `@/lib/server/convex`: a client that answers from the harness. */
export function serverConvexClient() {
  return {
    query: (
      reference: FunctionReference<"query">,
      args?: Record<string, unknown>
    ) => answer("query", reference, args),
    mutation: (
      reference: FunctionReference<"mutation">,
      args?: Record<string, unknown>
    ) => answer("mutation", reference, args),
  }
}

/** Replaces the provider turn runner with the next scripted attempt. */
export async function runProviderTextTurn(
  request: RunProviderTextTurnRequest,
  options: ProviderTextTurnOptions = {}
): Promise<CardChatResult> {
  const script =
    harness.attempts[harness.requests.length] ?? harness.attempts.at(-1)
  harness.requests.push(request)
  if (!script) throw new Error("No provider attempt was scripted")
  return script(request, options)
}

/** Replaces the turn-scoped approval bridge, recording how it was set up. */
export function createChatAgentSession(options: Record<string, unknown>) {
  harness.agentSessions.push(options)
  return {
    codex: undefined,
    handleRequest: undefined,
    close: async () => undefined,
  }
}

/** Replaces chat title generation with the harness's title. */
export async function generateChatTitle(
  options: Record<string, unknown>
): Promise<string | undefined> {
  harness.titleRequests.push(options)
  return harness.title
}

/** Replaces the Codex model list. */
export async function getCodexModelCatalog() {
  if (harness.codexCatalogError) throw harness.codexCatalogError
  return harness.codexModels
}

/** Records which unit's first question bank was started. */
export async function startFirstQuestionBank(unitId: string): Promise<void> {
  harness.questionBanks.push(unitId)
}

/** Places each project's folder under the harness directory. */
export async function prepareProjectAgentWorkspace(projectId: string) {
  return { projectDirectory: join(harness.projectsDirectory, projectId) }
}

/** Names the folder in the agent's instructions so a test can see which one it was given. */
export function projectAgentInstructions(workspaceDirectory: string): string {
  return `Work in ${workspaceDirectory}.`
}

/** Reports no artifacts. */
export async function scanProjectArtifacts(): Promise<[]> {
  return []
}

/** Returns a stored file's path from the harness. */
export async function resolveProjectFile(
  storageId: string,
  relativeKey: string
): Promise<string> {
  const path = harness.filePaths.get(`${storageId}/${relativeKey}`)
  if (!path) throw new Error("Stored file not found")
  return path
}

/** Returns a stored file's bytes from the harness. */
export async function readProjectFileBytes(
  storageId: string,
  relativeKey: string
): Promise<Uint8Array> {
  const bytes = harness.files.get(`${storageId}/${relativeKey}`)
  if (!bytes) throw new Error("Stored file not found")
  return bytes
}
