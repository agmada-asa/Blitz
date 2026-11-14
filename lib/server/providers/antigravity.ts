/**
 * Runs Antigravity through agent-engines' ACP engine, using the CLI's own
 * `agy acp` server, so Antigravity turns share the event path in
 * `engine-turn.ts` with every other provider.
 *
 * Blitz once ran Antigravity through a separate ACP package it installed and
 * signed in itself. The CLI now serves ACP directly and is signed in with the
 * same Google account as `agy` in a terminal, so Blitz only starts it.
 *
 * Antigravity has no per-process permission rules like OpenCode's, and `agy
 * acp` takes no mode flag, so sessions open in the CLI's configured mode. Its
 * `default` mode, the one it ships with, asks before edits and commands, and
 * the engine's access level answers those requests (see `acpAccess`). Turns
 * that must not change anything also start the CLI with `--sandbox`, which
 * restricts its terminal whatever mode it is in.
 */

import { AcpEngine, type AcpEngineOptions } from "agent-engines"

import type { ProviderTextTurnRequest } from "./types.ts"
import { providerCommand } from "./registry.ts"

/** The access settings of one turn that decide how Antigravity starts. */
export type AntigravityPolicyRequest = Pick<
  ProviderTextTurnRequest,
  "ephemeral" | "webSearchMode" | "approvalPolicy" | "sandbox"
>

/** Process seam for tests; omitted, the configured `agy` CLI is started. */
export type AntigravitySpawn = AcpEngineOptions["spawnProcess"]

/**
 * Returns whether a turn may not change anything: background work, which
 * reads untrusted source text, and read-only or no-approval chat turns.
 */
export function antigravityRestricted(policy: AntigravityPolicyRequest): boolean {
  return (
    Boolean(policy.ephemeral) ||
    policy.webSearchMode === "disabled" ||
    !policy.approvalPolicy ||
    policy.sandbox === "read-only" ||
    policy.approvalPolicy === "never"
  )
}

/**
 * Creates the ACP engine for one Antigravity turn, which the caller closes.
 *
 * @param policy - The turn's access settings; restricted turns run sandboxed.
 * @param workspaceDirectory - Absolute folder the agent works in.
 * @param spawnProcess - Optional fake process for tests.
 */
export function createAntigravityEngine(
  policy: AntigravityPolicyRequest,
  workspaceDirectory: string,
  spawnProcess?: AntigravitySpawn
): AcpEngine {
  const command = providerCommand("antigravity")
  return new AcpEngine({
    name: "Antigravity",
    command: command.executable,
    args: [
      ...command.args,
      ...(antigravityRestricted(policy) ? ["--sandbox"] : []),
    ],
    cwd: workspaceDirectory,
    clientName: "blitz",
    updater: "antigravity",
    ...(spawnProcess ? { spawnProcess } : {}),
  })
}
