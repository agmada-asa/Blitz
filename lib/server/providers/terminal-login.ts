/**
 * Opens a provider's interactive sign-in in a visible terminal window.
 *
 * OpenCode and Antigravity sign in through their own interactive CLIs, which
 * need a real terminal, so Settings opens one on the computer running Blitz:
 * Terminal on macOS, the desktop's terminal emulator on Linux, and a console
 * window on Windows. Where no window can be opened (a Linux server without a
 * desktop, or no terminal that starts), the error names the command to run by
 * hand.
 */

import { execFile, spawn } from "node:child_process"

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
 * Graphical-session variables a Linux terminal needs to reach the desktop.
 * The background server starts with the systemd user manager, at login or at
 * boot with lingering, before the desktop imports these into it, so its own
 * environment often lacks them while the manager's has them.
 */
const LINUX_SESSION_VARIABLES: readonly string[] = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "DBUS_SESSION_BUS_ADDRESS",
]

/**
 * Characters that `cmd.exe` would treat as syntax in a Windows command. A CLI
 * path containing one is refused rather than escaped. `(`, `)` and `@` are
 * included because `cmd /k` strips the quotes around a path with spaces that
 * contains one, so `C:\Program Files (x86)\…` would run `C:\Program`.
 */
const CMD_SYNTAX = /["%&|<>^()@]/

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

/**
 * Picks the graphical-session variables out of `systemctl --user
 * show-environment` output.
 *
 * @param output - Lines of `NAME=value`.
 * @returns Only the variables in `LINUX_SESSION_VARIABLES`. A value systemd
 *   wrote in `$'…'` form is skipped, since none of these normally needs one.
 */
export function parseSessionEnvironment(output: string): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    const name = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (LINUX_SESSION_VARIABLES.includes(name) && value && !value.startsWith("$'"))
      environment[name] = value
  }
  return environment
}

/**
 * Returns the environment a Linux terminal should start with. When this process
 * has no display, as with a background server started before the desktop, the
 * systemd user manager's current session variables are added.
 *
 * @param environment - This process's environment.
 * @returns It unchanged when it has a display, otherwise with the manager's
 *   session variables over it; unchanged too when `systemctl` is unavailable.
 */
async function linuxTerminalEnvironment(
  environment: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  if (environment.DISPLAY || environment.WAYLAND_DISPLAY) return environment
  const output = await new Promise<string>((resolve) =>
    execFile(
      "systemctl",
      ["--user", "show-environment"],
      { encoding: "utf8", timeout: 5_000 },
      (error, stdout) => resolve(error ? "" : stdout)
    )
  )
  return { ...environment, ...parseSessionEnvironment(output) }
}

/** How long a launcher that exits once the window is open may take. */
const LAUNCH_TIMEOUT_MS = 15_000

/**
 * How long a Linux terminal must keep running to count as opened. One that
 * cannot reach the display exits with an error well within this.
 */
const LINUX_EARLY_EXIT_MS = 1_500

/**
 * Starts one terminal launcher and waits until it has handed the window off.
 *
 * On Linux the terminal itself usually stays running, so success means it is
 * still running after `LINUX_EARLY_EXIT_MS`, or exited cleanly before then
 * (a client that hands the window to its server). An early failed exit counts
 * as unavailable, so the next terminal is tried. On macOS and Windows the
 * launcher (`osascript`, `cmd /c start`) exits as soon as the window is open,
 * so success means it exited cleanly in time; macOS may first ask the user to
 * let Blitz control Terminal.
 *
 * @param launch - The launcher and its arguments.
 * @param waitForExit - Whether the launcher exits once the window is open.
 * @param environment - The environment to start the launcher with.
 * @returns `"unavailable"` when the launcher is not installed or, on Linux,
 *   failed at once; otherwise `"opened"`.
 * @throws On macOS and Windows, when the launcher fails or does not finish in time.
 */
export function startLaunch(
  launch: TerminalLaunch,
  waitForExit: boolean,
  environment: NodeJS.ProcessEnv = process.env
): Promise<"opened" | "unavailable"> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const child = spawn(launch.command, [...launch.args], {
      detached: !waitForExit,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    })
    const finish = (outcome: "opened" | "unavailable" | Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!waitForExit) child.unref()
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    child.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT" || !waitForExit
          ? "unavailable"
          : new Error("The sign-in window could not open.")
      )
    )
    if (!waitForExit) {
      child.once("spawn", () => {
        timer = setTimeout(() => finish("opened"), LINUX_EARLY_EXIT_MS)
      })
      child.once("exit", (code) => finish(code === 0 ? "opened" : "unavailable"))
      return
    }
    timer = setTimeout(() => {
      child.kill()
      finish(new Error("The sign-in window did not open in time."))
    }, LAUNCH_TIMEOUT_MS)
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
  const environment =
    process.platform === "linux"
      ? await linuxTerminalEnvironment(process.env)
      : process.env
  const launches = terminalLaunches(process.platform, executable, args, environment)
  const waitForExit = process.platform === "darwin" || process.platform === "win32"
  for (const launch of launches)
    if ((await startLaunch(launch, waitForExit, environment)) === "opened") return
  throw new Error(`Run \`${manual}\` in a terminal, then check again.`)
}
