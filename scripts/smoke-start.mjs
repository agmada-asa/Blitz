/**
 * Starts Blitz the way the README says (`npm run dev`) from a fresh clone, then
 * checks it end to end: the launcher reports ready, a project can be created
 * and read back through local Convex, and its page is served. CI runs this on
 * Windows, where Blitz is not used day to day, so a change that breaks starting
 * there fails a check instead of a friend's first try.
 *
 * Usage: node scripts/smoke-start.mjs
 */

import { spawn, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const READY_TIMEOUT_MS = 10 * 60_000
const checkout = fileURLToPath(new URL("..", import.meta.url))
const port = Number(process.env.BLITZ_PORT ?? "3007")

const child = spawn(process.execPath, ["scripts/dev-lan.mjs", "--dev"], {
  cwd: checkout,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
})

let output = ""
/** Copies the launcher's output through and keeps it for the ready check. */
const forward = (stream) => (chunk) => {
  output += chunk.toString()
  stream.write(chunk)
}
child.stdout.on("data", forward(process.stdout))
child.stderr.on("data", forward(process.stderr))

let exitCode = 1
try {
  await waitForReady()
  // `convex dev` saved the ports it chose beside the database.
  const config = JSON.parse(
    readFileSync(join(checkout, ".convex", "local", "default", "config.json"), "utf8")
  )
  const convexUrl = `http://127.0.0.1:${config.ports.cloud}`
  const projectId = await convex(convexUrl, "mutation", "projects:createProject", {
    title: "Smoke test",
  })
  const project = await convex(convexUrl, "query", "projects:getProject", { projectId })
  if (project?.title !== "Smoke test")
    throw new Error(`The new project read back as ${JSON.stringify(project)}.`)
  const page = await fetch(`http://127.0.0.1:${port}/projects/${projectId}`)
  if (!page.ok) throw new Error(`The project page answered ${page.status}.`)
  console.log(`\n[smoke] Blitz started, saved project ${projectId} and served its page.`)
  exitCode = 0
} catch (error) {
  console.error(`\n[smoke] ${error instanceof Error ? error.message : error}`)
} finally {
  stopLauncher()
  process.exit(exitCode)
}

/** Resolves once the launcher prints that Blitz is ready, or throws if it exits or stalls. */
function waitForReady() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Blitz did not report ready in time.")),
      READY_TIMEOUT_MS
    )
    const check = setInterval(() => {
      if (!/Blitz is ready at/.test(output)) return
      clearInterval(check)
      clearTimeout(timer)
      resolve(undefined)
    }, 500)
    child.once("exit", (code) => {
      clearInterval(check)
      clearTimeout(timer)
      reject(new Error(`The launcher exited with ${code} before Blitz was ready.`))
    })
  })
}

/**
 * Calls a public Convex function over the local backend's HTTP API.
 * @param {string} url The local Convex URL.
 * @param {"query" | "mutation"} kind The function kind.
 * @param {string} path The function, as `module:name`.
 * @param {Record<string, unknown>} args Its arguments.
 */
async function convex(url, kind, path, args) {
  const response = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  })
  const body = await response.json()
  if (body.status !== "success")
    throw new Error(`${path} failed: ${body.errorMessage ?? response.status}`)
  return body.value
}

/** Stops the launcher and everything it started. */
function stopLauncher() {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {}
  } else child.kill("SIGTERM")
}
