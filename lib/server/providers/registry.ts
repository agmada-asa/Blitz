/** Registers Blitz's local providers and performs bounded executable checks. */

import { spawn } from "node:child_process"

import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_TASKS,
  type AiProviderId,
} from "../../ai-model-settings.ts"
import type {
  ProviderAdapterDefinition,
  ProviderAvailability,
  ProviderCapabilities,
  ProviderCommand,
  ProviderHealthOptions,
} from "./types.ts"

const DEFAULT_INSTANCE_ID = "local"
const PROBE_TIMEOUT_MS = 5_000

/** Provider capabilities used before a live provider session reports more detail. */
const CAPABILITIES: Readonly<Record<AiProviderId, ProviderCapabilities>> = {
  codex: {
    streaming: true,
    resumableSessions: true,
    structuredOutput: true,
    approvals: true,
    webSearch: true,
    workspaceWrites: true,
    sessionModelSwitch: false,
    promptlessTurnContinuation: false,
    conversationRollback: false,
  },
  "claude-code": {
    streaming: true,
    resumableSessions: true,
    structuredOutput: true,
    approvals: true,
    webSearch: false,
    workspaceWrites: true,
    sessionModelSwitch: false,
    promptlessTurnContinuation: false,
    conversationRollback: false,
  },
  opencode: {
    streaming: true,
    resumableSessions: true,
    structuredOutput: true,
    approvals: true,
    webSearch: false,
    workspaceWrites: true,
    sessionModelSwitch: false,
    promptlessTurnContinuation: false,
    conversationRollback: false,
  },
  antigravity: {
    streaming: true,
    resumableSessions: true,
    structuredOutput: true,
    approvals: true,
    webSearch: false,
    workspaceWrites: true,
    sessionModelSwitch: false,
    promptlessTurnContinuation: false,
    conversationRollback: false,
  },
}

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
    case "antigravity":
      return {
        executable:
          process.env.BLITZ_ANTIGRAVITY_ACP_COMMAND?.trim() ||
          "agy_acp_server.par",
        args: [],
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

/** Probes whether an executable starts successfully without logging its output. */
async function probeCommand(
  command: ProviderCommand,
  providerId?: AiProviderId
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
      const version = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
      if (
        providerId === "claude-code" &&
        (!version ||
          !(
            Number(version[1]) > 2 ||
            (Number(version[1]) === 2 &&
              (Number(version[2]) > 1 ||
                (Number(version[2]) === 1 && Number(version[3]) >= 248)))
          ))
      ) {
        finish({ available: false, reason: "unsupported" })
        return
      }
      if (
        providerId === "opencode" &&
        (!version ||
          Number(version[1]) !== 1 ||
          Number(version[2]) < 18 ||
          (Number(version[2]) === 18 && Number(version[3]) < 21))
      ) {
        finish({ available: false, reason: "unsupported" })
        return
      }
      finish({ available: true })
    })
  })
}

/** Checks one provider's local runtime without starting a model session. */
export async function checkProviderAvailability(
  providerId: AiProviderId,
  options: ProviderHealthOptions
): Promise<ProviderAvailability> {
  const instanceId =
    options.providerInstanceId ?? providerInstanceId(providerId)
  const result = await probeCommand(providerCommand(providerId), providerId)
  return result.available
    ? {
        providerId,
        providerInstanceId: instanceId,
        available: true,
        reason: "ready",
        message: "Installed. Sign in locally before running a turn.",
      }
    : {
        providerId,
        providerInstanceId: instanceId,
        available: false,
        reason: result.reason,
        message:
          result.reason === "unsupported"
            ? providerId === "opencode"
              ? "Install OpenCode 1.18.21 or newer within v1 for native permissions."
              : "Update Claude Code to version 2.1.248 or newer for restricted turns."
            : result.reason === "missing-executable"
              ? providerId === "antigravity"
                ? "Install Google Antigravity from the ACP registry, set BLITZ_ANTIGRAVITY_ACP_COMMAND to agy_acp_server.par, and sign in through an ACP client. The agy CLI is separate."
                : "Install this provider and sign in locally before selecting it."
              : `${providerId} did not pass its local runtime check.`,
      }
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
    capabilities: CAPABILITIES[providerId],
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
