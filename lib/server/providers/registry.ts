/**
 * Registers Blitz's local providers and checks each one's setup state.
 *
 * Codex and Claude Code are checked through agent-engines, which starts the
 * runtime without a model turn and reads its version, sign-in, and (for Codex)
 * model catalogue. OpenCode is checked through its own CLI.
 */

import { spawn } from "node:child_process"
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
        args: ["acp", "--pure"],
      }
  }
}

/** Returns the stable instance key used by the default local configuration. */
export function providerInstanceId(providerId: AiProviderId): string {
  const environmentName = `BLITZ_${providerId
    .replace(/[^A-Za-z0-9]/g, "_")
    .toUpperCase()}_INSTANCE`
  return process.env[environmentName]?.trim() || DEFAULT_INSTANCE_ID
}

/** Probes whether OpenCode starts and is a supported version, without logging its output. */
async function probeOpenCode(
  command: ProviderCommand
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
      if (!checkOpenCodeVersion(versionOutput).supported) {
        finish({ available: false, reason: "unsupported" })
        return
      }
      finish({ available: true })
    })
  })
}

/** Runs one non-interactive provider status command with bounded output. */
async function readCommand(
  executable: string,
  args: readonly string[]
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    let output = ""
    let settled = false
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", reject)
    child.on("close", (code) => finish({ code, output }))
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ code: null, output })
    }, PROBE_TIMEOUT_MS)
  })
}

/** Extracts configured provider names from OpenCode's human-readable credential list. */
export function parseOpenCodeAccounts(output: string): readonly string[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "")
  return clean.split("\n").flatMap((line) => {
    const match = line.match(/^\s*[●•]\s+(.+?)(?:\s{2,}|\s+(?:api|oauth)$)/i)
    return match?.[1]?.trim() ? [match[1].trim()] : []
  })
}

/** Reads OpenCode's configured accounts through its own status command. */
async function openCodeAuthentication(): Promise<
  Pick<
    ProviderAvailability,
    "authenticated" | "authMethods" | "accounts" | "canDisconnect"
  >
> {
  const command = providerCommand("opencode")
  const status = await readCommand(command.executable, ["auth", "list"])
  const accounts = status.code === 0 ? parseOpenCodeAccounts(status.output) : []
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
  try {
    const result = await probeOpenCode(providerCommand(providerId))
    if (!result.available)
      return {
        providerId,
        providerInstanceId: instanceId,
        available: false,
        authenticated: null,
        reason: result.reason,
        message:
          result.reason === "unsupported"
            ? openCodeVersionGuidance()
            : "Install this provider before connecting it to Blitz.",
      }
    const authentication = await openCodeAuthentication()
    return {
      providerId,
      providerInstanceId: instanceId,
      available: true,
      ...authentication,
      reason: authentication.authenticated === false ? "missing-auth" : "ready",
      message:
        authentication.authenticated === false
          ? "Installed, but not connected to Blitz."
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
