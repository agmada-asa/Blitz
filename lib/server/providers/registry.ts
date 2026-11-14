/**
 * Registers Blitz's local providers and checks each one's setup state.
 *
 * Codex and Claude Code are checked through agent-engines, which starts the
 * runtime without a model turn and reads its version, sign-in, and (for Codex)
 * model catalogue. OpenCode and Antigravity, which run over ACP, are checked
 * through their own CLIs, since ACP cannot report sign-in without starting a
 * session.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { CHAT_PROVIDER_CAPABILITIES } from "../../provider-capabilities.ts"

import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_TASKS,
  type AiProviderId,
} from "../../ai-model-settings.ts"
import type {
  ProviderAdapterDefinition,
  ProviderAvailability,
  ProviderCommand,
  ProviderHealthOptions,
} from "./types.ts"
import {
  createProviderEngine,
  providerAvailabilityFromEngine,
  providerModelOptions,
  type EngineProviderId,
} from "./engines.ts"
import {
  antigravityVersionGuidance,
  checkAntigravityVersion,
  checkOpenCodeVersion,
  openCodeVersionGuidance,
} from "./runtime-compat.ts"

const DEFAULT_INSTANCE_ID = "local"
const PROBE_TIMEOUT_MS = 5_000
const MAX_STATUS_BYTES = 16_000

/** Returns a local command without interpreting user input through a shell. */
export function providerCommand(providerId: AiProviderId): ProviderCommand {
  switch (providerId) {
    case "codex":
      return {
        executable: process.env.BLITZ_CODEX_COMMAND?.trim() || "codex",
        args: [],
      }
    case "claude-code":
      return {
        executable: process.env.BLITZ_CLAUDE_CODE_COMMAND?.trim() || "claude",
        args: [],
      }
    case "opencode":
      return {
        executable: process.env.BLITZ_OPENCODE_COMMAND?.trim() || "opencode",
        args: ["acp"],
      }
    case "antigravity":
      return {
        executable:
          process.env.BLITZ_ANTIGRAVITY_COMMAND?.trim() ||
          (existsSync(ANTIGRAVITY_INSTALLED_COMMAND)
            ? ANTIGRAVITY_INSTALLED_COMMAND
            : "agy"),
        args: ["acp"],
      }
  }
}

/**
 * Where Antigravity's installer puts `agy`. That folder is often missing from
 * the PATH a desktop app inherits, so this copy wins when it exists.
 */
const ANTIGRAVITY_INSTALLED_COMMAND = join(homedir(), ".local", "bin", "agy")

/** Returns the stable instance key used by the default local configuration. */
export function providerInstanceId(providerId: AiProviderId): string {
  const environmentName = `BLITZ_${providerId
    .replace(/[^A-Za-z0-9]/g, "_")
    .toUpperCase()}_INSTANCE`
  return process.env[environmentName]?.trim() || DEFAULT_INSTANCE_ID
}

/**
 * Probes whether an ACP provider's CLI starts and is a supported version,
 * without logging its output.
 *
 * @param command - The provider's configured command.
 * @param supported - Whether `--version` output names a supported release.
 */
async function probeAcpCli(
  command: ProviderCommand,
  supported: (versionOutput: string) => boolean
): Promise<
  | { available: true }
  | {
      available: false
      reason: "missing-executable" | "probe-failed" | "unsupported"
    }
> {
  return new Promise((resolve) => {
    let settled = false
    let versionOutput = ""
    const child = spawn(command.executable, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    child.stdout.on("data", (chunk: Buffer) => {
      if (versionOutput.length < 4096)
        versionOutput += chunk
          .toString("utf8")
          .slice(0, 4096 - versionOutput.length)
    })
    const finish = (
      value:
        | { available: true }
        | {
            available: false
            reason: "missing-executable" | "probe-failed" | "unsupported"
          }
    ): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ available: false, reason: "probe-failed" })
    }, PROBE_TIMEOUT_MS)
    child.on("error", (error: unknown) => {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined
      finish({
        available: false,
        reason: code === "ENOENT" ? "missing-executable" : "probe-failed",
      })
    })
    child.on("close", (code: unknown) => {
      if (code !== 0) {
        finish({ available: false, reason: "probe-failed" })
        return
      }
      if (!supported(versionOutput)) {
        finish({ available: false, reason: "unsupported" })
        return
      }
      finish({ available: true })
    })
  })
}

/**
 * Runs one non-interactive provider status command with bounded output.
 *
 * @param executable - The provider CLI.
 * @param args - Its arguments.
 * @param options - `stdoutOnly` leaves out diagnostics, for output that is
 *   parsed as JSON; `timeoutMs` replaces the default probe timeout.
 * @returns The exit code, or null when the command was stopped at its
 *   timeout, and the output read so far.
 *
 * Commands run from the temporary folder: sign-in is global, and OpenCode
 * v2's service answers `auth list` with a server error inside some project
 * folders, including this repository.
 */
export async function readCommand(
  executable: string,
  args: readonly string[],
  options: { stdoutOnly?: boolean; timeoutMs?: number } = {}
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const child = spawn(executable, args, {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", options.stdoutOnly ? "ignore" : "pipe"],
    })
    const finish = (result: { code: number | null; output: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_STATUS_BYTES)
        output += chunk
          .toString("utf8")
          .slice(0, MAX_STATUS_BYTES - output.length)
    }
    child.stdout?.on("data", append)
    child.stderr?.on("data", append)
    child.on("error", reject)
    child.on("close", (code) => finish({ code, output }))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, output })
    }, options.timeoutMs ?? PROBE_TIMEOUT_MS)
  })
}

/** One OpenCode integration with saved credentials, from `opencode auth list`. */
export type OpenCodeIntegration = {
  /** Integration ID, such as `openai`. */
  readonly id: string
  /** Display name, such as `OpenAI`, shown as the account in Settings. */
  readonly name: string
  /** IDs of its saved credentials, which `opencode auth logout` takes. */
  readonly credentialIds: readonly string[]
}

/**
 * Reads the integrations that have saved credentials from OpenCode v2's
 * `auth list --format json` output. Entries without a usable ID, name or
 * credential are left out, and output that is not the expected JSON gives none.
 */
export function parseOpenCodeIntegrations(
  output: string
): readonly OpenCodeIntegration[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry: unknown): OpenCodeIntegration[] => {
    if (typeof entry !== "object" || entry === null) return []
    const { id, name, connections } = entry as Record<string, unknown>
    if (typeof id !== "string" || !id.trim() || !Array.isArray(connections))
      return []
    const credentialIds = connections.flatMap((connection: unknown) => {
      const value =
        typeof connection === "object" && connection !== null
          ? (connection as Record<string, unknown>)
          : undefined
      return value?.type === "credential" &&
        typeof value.id === "string" &&
        value.id.trim()
        ? [value.id.trim()]
        : []
    })
    if (!credentialIds.length) return []
    return [
      {
        id: id.trim(),
        name: typeof name === "string" && name.trim() ? name.trim() : id.trim(),
        credentialIds,
      },
    ]
  })
}

/** Reads OpenCode's integrations with saved credentials; none when the command fails. */
export async function readOpenCodeIntegrations(): Promise<
  readonly OpenCodeIntegration[]
> {
  const command = providerCommand("opencode")
  const status = await readCommand(
    command.executable,
    ["auth", "list", "--format", "json"],
    { stdoutOnly: true }
  )
  return status.code === 0 ? parseOpenCodeIntegrations(status.output) : []
}

/** Reads OpenCode's configured accounts through its own status command. */
async function openCodeAuthentication(): Promise<
  Pick<
    ProviderAvailability,
    "authenticated" | "authMethods" | "accounts" | "canDisconnect"
  >
> {
  const accounts = (await readOpenCodeIntegrations()).map(
    (integration) => integration.name
  )
  return {
    authenticated: accounts.length > 0,
    accounts,
    canDisconnect: accounts.length > 0,
    authMethods: [
      {
        id: "opencode-login",
        name: "Add an OpenCode provider",
        description:
          "Choose a model provider and finish its sign-in in Terminal.",
        type: "terminal",
      },
    ],
  }
}

/**
 * Longest wait for `agy models`, which asks Antigravity's service for the
 * account's models (about two seconds when signed in).
 */
const ANTIGRAVITY_AUTH_TIMEOUT_MS = 20_000

/**
 * Reads whether Antigravity is signed in by asking its CLI for the account's
 * models, which needs a signed-in account but starts no conversation. An exit
 * with no model listed means signed out; a command stopped at its timeout
 * leaves the answer unknown.
 */
async function antigravityAuthentication(): Promise<
  Pick<ProviderAvailability, "authenticated" | "authMethods" | "canDisconnect">
> {
  const command = providerCommand("antigravity")
  const status = await readCommand(command.executable, ["models"], {
    stdoutOnly: true,
    timeoutMs: ANTIGRAVITY_AUTH_TIMEOUT_MS,
  })
  // Each model is one `id<TAB>name` line after a progress line.
  const listed = status.output.split("\n").some((line) => line.includes("\t"))
  return {
    authenticated: status.code === null ? null : status.code === 0 && listed,
    // Antigravity's sign-out lives in its own CLI, not in Blitz.
    canDisconnect: false,
    authMethods: [
      {
        id: "antigravity-login",
        name: "Sign in to Antigravity",
        description: "Finish the Google sign-in in Terminal.",
        type: "terminal",
      },
    ],
  }
}

/** Sign-in choice the settings page offers for each engine provider. */
const ENGINE_AUTH_METHODS: Readonly<
  Record<EngineProviderId, NonNullable<ProviderAvailability["authMethods"]>>
> = {
  codex: [{ id: "codex-login", name: "Continue with ChatGPT", type: "agent" }],
  "claude-code": [
    { id: "claude-login", name: "Sign in to Claude", type: "agent" },
  ],
}

/**
 * Checks Codex or Claude Code through agent-engines, adding the signed-in
 * Codex catalogue when it can be read. Never throws.
 */
async function checkEngineAvailability(
  providerId: EngineProviderId,
  instanceId: string
): Promise<ProviderAvailability> {
  const engine = createProviderEngine(providerId)
  try {
    const state = providerAvailabilityFromEngine(
      providerId,
      instanceId,
      await engine.availability()
    )
    let models: ProviderAvailability["models"]
    if (providerId === "codex" && state.authenticated === true) {
      try {
        models = providerModelOptions(await engine.models())
      } catch {
        // Sign-in state stays useful even if this optional catalogue read fails.
        models = undefined
      }
    }
    return {
      ...state,
      ...(state.available ? { authMethods: ENGINE_AUTH_METHODS[providerId] } : {}),
      ...(models === undefined ? {} : { models }),
    }
  } finally {
    await engine.close().catch(() => undefined)
  }
}

/** Checks one provider's local runtime without starting a model session. */
export async function checkProviderAvailability(
  providerId: AiProviderId,
  options: ProviderHealthOptions
): Promise<ProviderAvailability> {
  const instanceId =
    options.providerInstanceId ?? providerInstanceId(providerId)
  if (providerId === "codex" || providerId === "claude-code")
    return checkEngineAvailability(providerId, instanceId)
  const antigravity = providerId === "antigravity"
  try {
    const result = await probeAcpCli(
      providerCommand(providerId),
      (output) =>
        (antigravity ? checkAntigravityVersion : checkOpenCodeVersion)(output)
          .supported
    )
    if (!result.available)
      return {
        providerId,
        providerInstanceId: instanceId,
        available: false,
        authenticated: null,
        reason: result.reason,
        message:
          result.reason === "unsupported"
            ? antigravity
              ? antigravityVersionGuidance()
              : openCodeVersionGuidance()
            : "Install this provider before connecting it to Blitz.",
      }
    const authentication = antigravity
      ? await antigravityAuthentication()
      : await openCodeAuthentication()
    return {
      providerId,
      providerInstanceId: instanceId,
      available: true,
      ...authentication,
      reason: authentication.authenticated === false ? "missing-auth" : "ready",
      message:
        authentication.authenticated === false
          ? "Installed, but not connected to Blitz."
          : authentication.authenticated === null
            ? "Installed. Blitz couldn't confirm the sign-in, so check again."
            : "Connected and ready.",
    }
  } catch (error) {
    const missingExecutable = isMissingExecutable(error)
    return {
      providerId,
      providerInstanceId: instanceId,
      available: false,
      authenticated: null,
      reason: missingExecutable ? "missing-executable" : "probe-failed",
      message:
        `${providerId} did not pass its local runtime check.`,
    }
  }
}

/**
 * Checks only that a supported Antigravity CLI is installed, without the
 * slower sign-in check, for use before each turn.
 *
 * @returns Setup guidance when it is missing or too old; undefined when ready.
 */
export async function checkAntigravityInstalled(): Promise<string | undefined> {
  const result = await probeAcpCli(
    providerCommand("antigravity"),
    (output) => checkAntigravityVersion(output).supported
  )
  if (result.available) return undefined
  return result.reason === "unsupported"
    ? antigravityVersionGuidance()
    : "Install Antigravity before using it in Blitz."
}

/** Returns whether a spawn failure, or the error it caused, means the CLI is not installed. */
function isMissingExecutable(error: unknown): boolean {
  for (const value of [error, (error as { cause?: unknown } | null)?.cause])
    if (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      value.code === "ENOENT"
    )
      return true
  return false
}

/** Returns one provider definition with its stable capability snapshot. */
function definition(
  providerId: AiProviderId,
  displayName: string
): ProviderAdapterDefinition {
  return {
    providerId,
    displayName,
    tasks: AI_PROVIDER_TASKS[providerId],
    capabilities: CHAT_PROVIDER_CAPABILITIES[providerId],
    checkAvailability: (options) =>
      checkProviderAvailability(providerId, options),
  }
}

/** All first-party Blitz providers in settings order. */
export const PROVIDER_DEFINITIONS: readonly ProviderAdapterDefinition[] = [
  definition("codex", "Codex"),
  definition("claude-code", "Claude Code"),
  definition("opencode", "OpenCode"),
  definition("antigravity", "Antigravity"),
]

/** Returns the registered provider definition or throws for an invalid ID. */
export function getProviderDefinition(
  providerId: AiProviderId
): ProviderAdapterDefinition {
  const provider = PROVIDER_DEFINITIONS.find(
    (candidate) => candidate.providerId === providerId
  )
  if (!provider) throw new Error(`Provider ${providerId} is not registered`)
  return provider
}

/** Confirms the registry still contains every persisted provider ID. */
export function registeredProviderIds(): readonly AiProviderId[] {
  return AI_PROVIDER_IDS.filter((providerId) =>
    PROVIDER_DEFINITIONS.some((provider) => provider.providerId === providerId)
  )
}
