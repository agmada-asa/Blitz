/** Owns user-initiated connect and disconnect operations for local AI providers. */

import { spawn } from "node:child_process"

import type { AiProviderId } from "../../ai-model-settings.ts"
import { changeAcpAuthentication } from "./acp.ts"
import { installAntigravityRuntime } from "./antigravity-runtime.ts"
import { checkProviderAvailability, providerCommand } from "./registry.ts"

const AUTH_TIMEOUT_MS = 15_000

/** Runs a bounded non-interactive credential command without exposing its output. */
async function runCredentialCommand(
  executable: string,
  args: readonly string[]
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(executable, args, { stdio: "ignore" })
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

/** Opens OpenCode's interactive provider chooser in a visible macOS Terminal window. */
async function openOpenCodeLogin(executable: string): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error(
      "Run `opencode auth login` in a terminal, then check again."
    )
  const command = `${shellQuote(executable)} auth login`
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
  if (input.action === "install") {
    if (input.providerId !== "antigravity")
      throw new Error("Blitz cannot install this provider automatically.")
    const executable = await installAntigravityRuntime()
    await changeAcpAuthentication(
      { executable, args: [] },
      input.workspaceDirectory,
      { type: "connect", methodId: "oauth-personal" }
    )
    return
  }
  const state = await checkProviderAvailability(input.providerId, {
    workspaceDirectory: input.workspaceDirectory,
  })
  if (!state.available) throw new Error(state.message)
  const command = providerCommand(input.providerId)

  if (input.providerId === "antigravity") {
    await changeAcpAuthentication(
      command,
      input.workspaceDirectory,
      input.action === "connect"
        ? { type: "connect", methodId: input.methodId ?? "" }
        : { type: "disconnect" }
    )
    return
  }

  if (input.action === "connect") {
    if (input.providerId === "codex") {
      await startNativeLogin(command.executable, ["login"])
      return
    }
    if (input.providerId === "claude-code") {
      await startNativeLogin(command.executable, ["auth", "login"])
      return
    }
    await openOpenCodeLogin(command.executable)
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
  const account = input.account?.trim()
  if (!account || !state.accounts?.includes(account))
    throw new Error("Choose an OpenCode account to disconnect.")
  await runCredentialCommand(command.executable, ["auth", "logout", account])
}
