/** Owns user-initiated connect and disconnect operations for local AI providers. */

import { spawn } from "node:child_process"
import { tmpdir } from "node:os"

import type { AiProviderId } from "../../ai-model-settings.ts"
import {
  checkProviderAvailability,
  providerCommand,
  readOpenCodeIntegrations,
} from "./registry.ts"

const AUTH_TIMEOUT_MS = 15_000

/** Runs a bounded non-interactive credential command without exposing its output. */
async function runCredentialCommand(
  executable: string,
  args: readonly string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    // Credentials are global; OpenCode v2's service fails inside some project folders.
    const child = spawn(executable, args, { cwd: tmpdir(), stdio: "ignore" })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.on("error", () =>
      finish(new Error("The provider command could not start."))
    )
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error("The provider did not complete the request.")
      )
    )
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error("The provider did not finish in time."))
    }, AUTH_TIMEOUT_MS)
  })
}

/** Starts a browser-based native login and confirms that its process launched. */
async function startNativeLogin(
  executable: string,
  args: readonly string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: "ignore",
    })
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
    child.once("error", () => {
      reject(new Error("The provider login could not start."))
    })
  })
}

/** Quotes a fixed local executable for a Terminal command without evaluating user input. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * Runs a provider's interactive sign-in in a visible macOS Terminal window.
 *
 * @param executable - The provider CLI, quoted for the shell.
 * @param args - Fixed sign-in arguments; never user input.
 * @param manual - The command named in the error on other platforms.
 */
async function openTerminalLogin(
  executable: string,
  args: string,
  manual: string
): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error(`Run \`${manual}\` in a terminal, then check again.`)
  const command = `${shellQuote(executable)} ${args}`
  const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`
  await runCredentialCommand("/usr/bin/osascript", ["-e", script])
}

/** Applies one explicit provider authentication action from the settings page. */
export async function changeProviderAuthentication(input: {
  providerId: AiProviderId
  action: "connect" | "disconnect" | "install"
  workspaceDirectory: string
  methodId?: string
  account?: string
}): Promise<void> {
  if (input.action === "install")
    throw new Error("Blitz cannot install this provider automatically.")
  const state = await checkProviderAvailability(input.providerId, {
    workspaceDirectory: input.workspaceDirectory,
  })
  if (!state.available) throw new Error(state.message)
  const command = providerCommand(input.providerId)

  if (input.action === "connect") {
    if (input.providerId === "codex") {
      await startNativeLogin(command.executable, ["login"])
      return
    }
    if (input.providerId === "claude-code") {
      await startNativeLogin(command.executable, ["auth", "login"])
      return
    }
    if (input.providerId === "antigravity") {
      // `agy acp --login` signs in with Google, then exits.
      await openTerminalLogin(command.executable, "acp --login", "agy acp --login")
      return
    }
    await openTerminalLogin(command.executable, "auth login", "opencode auth login")
    return
  }

  if (input.providerId === "codex") {
    await runCredentialCommand(command.executable, ["logout"])
    return
  }
  if (input.providerId === "claude-code") {
    await runCredentialCommand(command.executable, ["auth", "logout"])
    return
  }
  if (input.providerId === "antigravity")
    throw new Error("Sign out of Antigravity in its own app or CLI.")
  const account = input.account?.trim()
  const integration = (await readOpenCodeIntegrations()).find(
    (candidate) => candidate.name === account
  )
  if (!account || !integration)
    throw new Error("Choose an OpenCode account to disconnect.")
  // Naming each credential keeps OpenCode from opening its account picker.
  for (const credentialId of integration.credentialIds)
    await runCredentialCommand(command.executable, [
      "auth",
      "logout",
      integration.id,
      credentialId,
    ])
}
