/**
 * Runs OpenCode through agent-engines' ACP engine, so OpenCode turns share the
 * Codex and Claude Code event path in `engine-turn.ts`.
 *
 * The library owns the ACP protocol: the agent process, sessions, streaming,
 * permission and elicitation requests, and cleanup. Blitz keeps what is its
 * own policy: the per-turn OpenCode environment from `opencode-policy.ts`
 * (native permissions and a dedicated Blitz agent). What OpenCode shares with
 * Antigravity, the other ACP provider, is in `acp-providers.ts`.
 */

import {
  ACP_AGENTS,
  AcpEngine,
  type AcpEngineOptions,
} from "agent-engines"

import { tmpdir } from "node:os"

import { providerModelOptions } from "./engines.ts"
import { openCodeEnvironment, type OpenCodePolicyRequest } from "./opencode-policy.ts"
import { providerCommand } from "./registry.ts"
import { windowsSpawnOption } from "./spawn-command.ts"
import type { ProviderModelOption } from "./types.ts"

/**
 * Name of the OpenCode agent that carries each turn's permissions.
 *
 * OpenCode remembers the agent a session last used and refuses to prompt a
 * reloaded session whose agent no longer exists, so the name is the same on
 * every turn: each turn redefines the agent with that turn's permissions.
 * Sessions saved under the per-turn names Blitz used before fail to resume,
 * and the chat replays their history into a new session instead.
 */
export const OPENCODE_AGENT_NAME = "blitz-turn"

/** Process seam for tests; omitted, the configured `opencode` CLI is started. */
export type OpenCodeSpawn = AcpEngineOptions["spawnProcess"]

/**
 * Creates the ACP engine for one OpenCode turn, which the caller closes.
 *
 * The environment carries the turn's permission policy, so an engine serves
 * exactly one turn. The agent process starts in the workspace, as Blitz's own
 * adapter did, and only when the engine is first used.
 *
 * @param policy - The turn's access settings, which decide its permissions.
 * @param workspaceDirectory - Absolute folder the agent works in.
 * @param spawnProcess - Optional fake process for tests.
 */
export function createOpenCodeEngine(
  policy: OpenCodePolicyRequest,
  workspaceDirectory: string,
  spawnProcess?: OpenCodeSpawn
): AcpEngine {
  const command = providerCommand("opencode")
  return new AcpEngine({
    name: ACP_AGENTS.opencode.name,
    command: command.executable,
    args: command.args,
    cwd: workspaceDirectory,
    env: openCodeEnvironment(policy, OPENCODE_AGENT_NAME),
    clientName: "blitz",
    ...(spawnProcess ? { spawnProcess } : windowsSpawnOption()),
  })
}

/** Longest wait for OpenCode to open a probe session and list its models. */
const OPENCODE_CATALOG_TIMEOUT_MS = 10_000

/** How long one catalogue read is reused, so reopening a picker does not respawn OpenCode. */
const OPENCODE_CATALOG_TTL_MS = 30_000

/** The last catalogue read and when it stops being reused. */
let cachedCatalog:
  | { readonly expiresAt: number; readonly models: readonly ProviderModelOption[] }
  | undefined

/**
 * Lists every model the signed-in OpenCode offers, from every provider
 * connected to it, so Settings can show and search them all.
 *
 * Reads the catalogue from a probe session with every tool denied, which
 * starts no conversation. Blitz sends ACP providers no reasoning level, so each
 * model offers only its default.
 *
 * @returns OpenCode's models in its own order, reused for 30 seconds.
 * @throws When OpenCode cannot start or does not answer in time.
 */
export async function listOpenCodeModels(): Promise<
  readonly ProviderModelOption[]
> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now())
    return cachedCatalog.models
  const engine = createOpenCodeEngine({ ephemeral: true }, tmpdir())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const catalog = await Promise.race([
      engine.models(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OpenCode did not list its models in time")),
          OPENCODE_CATALOG_TIMEOUT_MS
        )
      }),
    ])
    const models = providerModelOptions(catalog).map(
      (option): ProviderModelOption => ({
        ...option,
        reasoningEfforts: ["default"],
      })
    )
    cachedCatalog = { expiresAt: Date.now() + OPENCODE_CATALOG_TTL_MS, models }
    return models
  } finally {
    clearTimeout(timer)
    await engine.close().catch(() => undefined)
  }
}
