/**
 * Opens a provider's interactive sign-in in a visible terminal window.
 *
 * OpenCode and Antigravity sign in through their own interactive CLIs, which
 * need a real terminal, so Settings opens one on the computer running Blitz:
 * Terminal on macOS, the desktop's terminal emulator on Linux, and a console
 * window on Windows. Where no window can be opened (a Linux server without a
 * desktop, or no known terminal installed), the error names the command to run
 * by hand.
 */

import { spawn } from "node:child_process"

/** One way to open a terminal window running the sign-in command. */
export type TerminalLaunch = Readonly<{ command: string; args: readonly string[] }>

/**
 * Shell script each Linux terminal runs: the sign-in, then a pause, so the
 * window stays open long enough to read the CLI's result or error. The CLI and
 * its arguments arrive as positional parameters, so nothing is quoted by hand.
 */
const LINUX_LOGIN_SCRIPT =
  "\"$0\" \"$@\"; printf '\\nPress Enter to close this window. '; read _"

/**
 * Linux terminal emulators in the order Blitz tries them, each with the
 * arguments that come before the command it should run. `x-terminal-emulator`
 * is Debian and Ubuntu's link to the chosen default and takes `-e` by policy.
 */
const LINUX_TERMINALS: readonly TerminalLaunch[] = [
  { command: "x-terminal-emulator", args: ["-e"] },
  { command: "ptyxis", args: ["--"] },
  { command: "gnome-terminal", args: ["--"] },
  { command: "kgx", args: ["--"] },
  { command: "konsole", args: ["-e"] },
  { command: "xfce4-terminal", args: ["-x"] },
  { command: "kitty", args: [] },
  { command: "alacritty", args: ["-e"] },
  { command: "wezterm", args: ["start", "--"] },
  { command: "foot", args: [] },
  { command: "xterm", args: ["-e"] },
]

/**
 * Characters that `cmd.exe` would treat as syntax in an unquoted Windows
 * command. A CLI path containing one is refused rather than escaped.
 */
const CMD_SYNTAX = /["%&|<>^]/

/**
 * Quotes a fixed local executable for a POSIX shell without evaluating it.
 *
 * @param value - The CLI path or name.
 * @returns The value in single quotes, with embedded quotes escaped.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/**
 * Lists the ways to open a terminal window running a sign-in command on one
 * platform, in the order to try them.
 *
 * @param platform - The operating system, as `process.platform` names it.
 * @param executable - The provider CLI, as a bare name or a path.
 * @param args - Fixed sign-in arguments; never user input.
 * @param environment - Used on Linux to check for a graphical session.
 * @returns The launches to try; empty when this computer cannot show a window.
 */
export function terminalLaunches(
  platform: NodeJS.Platform,
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): TerminalLaunch[] {
  if (platform === "darwin") {
    const command = [executable, ...args].map(shellQuote).join(" ")
    const script = `tell application "Terminal" to do script ${JSON.stringify(command)}`
    return [{ command: "/usr/bin/osascript", args: ["-e", script] }]
  }
  if (platform === "win32") {
    if ([executable, ...args].some((part) => CMD_SYNTAX.test(part))) return []
    // `start` opens a new console window; `cmd /k` keeps it open afterwards so
    // the CLI's result stays readable. The quoted first argument is the title.
    return [
      {
        command: "cmd.exe",
        args: ["/d", "/c", "start", "Sign in", "cmd", "/k", executable, ...args],
      },
    ]
  }
  // A server without a desktop session has nowhere to show a window.
  if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) return []
  return LINUX_TERMINALS.map((terminal) => ({
    command: terminal.command,
    args: [...terminal.args, "sh", "-c", LINUX_LOGIN_SCRIPT, executable, ...args],
  }))
}

/** How long a launcher that exits once the window is open may take. */
const LAUNCH_TIMEOUT_MS = 15_000

/**
 * Starts one terminal launcher and waits until it has handed the window off.
 *
 * On Linux the terminal itself stays running, so success means it started.
 * On macOS and Windows the launcher (`osascript`, `cmd /c start`) exits as soon
 * as the window is open, so success means it exited cleanly in time; macOS may
 * first ask the user to let Blitz control Terminal.
 *
 * @param launch - The launcher and its arguments.
 * @param waitForExit - Whether the launcher exits once the window is open.
 * @returns `"missing"` when the launcher is not installed, otherwise `"opened"`.
 * @throws When the launcher starts but fails or does not finish in time.
 */
function startLaunch(
  launch: TerminalLaunch,
  waitForExit: boolean
): Promise<"opened" | "missing"> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args], {
      detached: !waitForExit,
      stdio: "ignore",
      windowsHide: true,
    })
    // Child events arrive asynchronously, so `finish` never runs before this.
    const timer = waitForExit
      ? setTimeout(() => {
          child.kill()
          finish(new Error("The sign-in window did not open in time."))
        }, LAUNCH_TIMEOUT_MS)
      : undefined
    const finish = (outcome: "opened" | "missing" | Error): void => {
      clearTimeout(timer)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT"
          ? "missing"
          : new Error("The sign-in window could not open.")
      )
    )
    if (!waitForExit) {
      child.once("spawn", () => {
        child.unref()
        finish("opened")
      })
      return
    }
    child.once("close", (code) =>
      finish(code === 0 ? "opened" : new Error("The sign-in window could not open."))
    )
  })
}

/**
 * Runs a provider's interactive sign-in in a visible terminal window.
 *
 * @param executable - The provider CLI, as a bare name or a path.
 * @param args - Fixed sign-in arguments; never user input.
 * @param manual - The command to name when no window can be opened.
 * @throws With that command when this computer cannot open a window.
 */
export async function openTerminalLogin(
  executable: string,
  args: readonly string[],
  manual: string
): Promise<void> {
  const launches = terminalLaunches(process.platform, executable, args, process.env)
  const waitForExit = process.platform === "darwin" || process.platform === "win32"
  for (const launch of launches)
    if ((await startLaunch(launch, waitForExit)) === "opened") return
  throw new Error(`Run \`${manual}\` in a terminal, then check again.`)
}
