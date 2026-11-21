/** Verifies how each platform opens a terminal window for a provider sign-in. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"

import { terminalLaunches } from "../lib/server/providers/terminal-login.ts"

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

test("Windows refuses a CLI path that cmd would read as syntax", () => {
  assert.deepEqual(terminalLaunches("win32", "C:\\a&b\\opencode.cmd", ["auth", "login"], {}), [])
})

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
