/** Verifies how each platform opens a terminal window for a provider sign-in. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"

import {
  openTerminalLogin,
  parseSessionEnvironment,
  startLaunch,
  terminalLaunches,
} from "../lib/server/providers/terminal-login.ts"

test("macOS opens the sign-in in Terminal with the CLI path quoted", () => {
  const [launch, ...rest] = terminalLaunches(
    "darwin",
    "/Applications/My App/agy",
    ["acp", "--login"],
    {}
  )
  assert.equal(rest.length, 0)
  assert.equal(launch.command, "/usr/bin/osascript")
  assert.match(launch.args[1], /do script "'\/Applications\/My App\/agy' 'acp' '--login'"/)
})

test("Windows opens a console window that stays open", () => {
  assert.deepEqual(
    terminalLaunches("win32", "C:\\Program Files\\agy\\agy.exe", ["acp", "--login"], {}),
    [
      {
        command: "cmd.exe",
        args: [
          "/d",
          "/c",
          "start",
          "Sign in",
          "cmd",
          "/k",
          "C:\\Program Files\\agy\\agy.exe",
          "acp",
          "--login",
        ],
      },
    ]
  )
})

test(
  "Windows runs the sign-in in a new console with the CLI path and arguments intact",
  { skip: process.platform !== "win32" && "needs cmd.exe" },
  async () => {
    // A folder with spaces makes cmd /k see a quoted path, the case its quote
    // rules are most likely to break.
    const directory = await mkdtemp(join(tmpdir(), "blitz sign in "))
    try {
      const output = join(directory, "args.txt")
      // `exit` closes the console once the fake CLI has recorded its arguments.
      await writeFile(
        join(directory, "fake cli.cmd"),
        '@echo off\r\necho %*> "%~dp0args.txt"\r\nexit\r\n'
      )
      await openTerminalLogin(join(directory, "fake cli.cmd"), ["acp", "--login"], "x")
      for (let waited = 0; !existsSync(output) && waited < 15_000; waited += 250)
        await delay(250)
      assert.equal((await readFile(output, "utf8")).trim(), "acp --login")
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  }
)

test("Windows refuses a CLI path that cmd would read as syntax", () => {
  assert.deepEqual(terminalLaunches("win32", "C:\\a&b\\opencode.cmd", ["auth", "login"], {}), [])
  // `cmd /k` would strip the quotes around this path and run `C:\Program`.
  assert.deepEqual(
    terminalLaunches("win32", "C:\\Program Files (x86)\\agy\\agy.exe", ["acp", "--login"], {}),
    []
  )
})

test("the systemd manager's display variables are read, and nothing else", () => {
  assert.deepEqual(
    parseSessionEnvironment(
      [
        "HOME=/home/sam",
        "DISPLAY=:0",
        "WAYLAND_DISPLAY=wayland-0",
        "XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.ABC123",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
        "PATH=/usr/bin",
        "",
      ].join("\n")
    ),
    {
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XAUTHORITY: "/run/user/1000/.mutter-Xwaylandauth.ABC123",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    }
  )
  assert.deepEqual(parseSessionEnvironment("DISPLAY=$'odd\\nvalue'\n"), {})
})

test(
  "a Linux terminal that is missing or fails at once is skipped; one that runs has opened",
  { skip: process.platform === "win32" && "needs a POSIX shell" },
  async () => {
    assert.equal(await startLaunch({ command: "blitz-no-such-terminal", args: [] }, false), "unavailable")
    assert.equal(await startLaunch({ command: "sh", args: ["-c", "exit 1"] }, false), "unavailable")
    assert.equal(await startLaunch({ command: "sh", args: ["-c", "exit 0"] }, false), "opened")
    assert.equal(await startLaunch({ command: "sleep", args: ["2"] }, false), "opened")
  }
)

test("Linux tries the desktop's terminals, starting with the system default", () => {
  const launches = terminalLaunches("linux", "opencode", ["auth", "login"], {
    DISPLAY: ":0",
  })
  assert.equal(launches[0].command, "x-terminal-emulator")
  assert.ok(launches.some((launch) => launch.command === "gnome-terminal"))
  assert.ok(launches.some((launch) => launch.command === "konsole"))
  assert.equal(launches.at(-1)?.command, "xterm")
  for (const launch of launches)
    assert.deepEqual(launch.args.slice(-6), [
      "sh",
      "-c",
      launch.args.at(-4),
      "opencode",
      "auth",
      "login",
    ])
})

test("Linux without a desktop session opens nothing", () => {
  assert.deepEqual(terminalLaunches("linux", "opencode", ["auth", "login"], {}), [])
  assert.ok(
    terminalLaunches("linux", "opencode", ["auth", "login"], { WAYLAND_DISPLAY: "wayland-0" })
      .length > 0
  )
})

test(
  "the Linux script runs the CLI with its arguments intact, then waits",
  { skip: process.platform === "win32" && "needs a POSIX shell" },
  () => {
    const [launch] = terminalLaunches("linux", "printf", ["%s|", "it's", "a b"], {
      DISPLAY: ":0",
    })
    // Drop the terminal's own arguments and run the shell part directly.
    const shell = launch.args.slice(launch.args.indexOf("sh"))
    const output = execFileSync(shell[0], shell.slice(1), {
      input: "\n",
      encoding: "utf8",
    })
    assert.ok(output.startsWith("it's|a b|"))
    assert.match(output, /Press Enter to close this window/)
  }
)
