/**
 * Starts provider CLIs in a way that also works on Windows.
 *
 * npm installs a CLI such as `codex` or `opencode` on Windows as a `.cmd`
 * script, which Node's `spawn` cannot start without a shell: a bare name is
 * not found, and a `.cmd` path is refused. cross-spawn finds the script on
 * PATH and quotes its arguments for `cmd.exe`. Other platforms keep Node's own
 * `spawn`, so nothing changes on macOS or Linux.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import crossSpawn from "cross-spawn"

/** Node's `spawn`, or cross-spawn on Windows, with the same signature. */
export const spawnCommand: typeof nodeSpawn =
  process.platform === "win32"
    ? (crossSpawn as unknown as typeof nodeSpawn)
    : nodeSpawn

/**
 * Starts a long-running provider process with piped stdio, in the shape
 * agent-engines' `spawnProcess` option takes for Codex and ACP engines.
 *
 * @param command - The provider CLI, as a bare name or a path.
 * @param args - Its arguments.
 * @param options - The working folder and environment.
 */
export function spawnProviderProcess(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env: NodeJS.ProcessEnv }>
): ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>
  stdout: NonNullable<ChildProcess["stdout"]>
  stderr: NonNullable<ChildProcess["stderr"]>
} {
  return spawnCommand(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
}

/**
 * The `spawnProcess` option for agent-engines on Windows, or nothing
 * elsewhere, where the library's own spawn already works.
 */
export function windowsSpawnOption():
  | { spawnProcess: typeof spawnProviderProcess }
  | Record<string, never> {
  return process.platform === "win32"
    ? { spawnProcess: spawnProviderProcess }
    : {}
}
