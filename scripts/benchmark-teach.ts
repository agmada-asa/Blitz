/**
 * Measures how fast course material becomes teachable.
 *
 * Imports a folder of real material into a new module as one unit through the
 * same upload route the app uses, and reports how long each file took to
 * extract. With `--teach`, it also starts the unit's Teach session and
 * reports time to the first streamed words and to the finished first section.
 * `--prewarm` asks the server to prewarm the provider just before the turn,
 * as the Teach screen does when a session opens, so runs with and without it
 * can be compared.
 *
 *   npm run benchmark:teach -- <folder> [--match text]... [--title name] [--teach] [--prewarm]
 *
 * Requires a running Blitz (`npm run dev:lan`). `--teach` runs one real tutor
 * turn on the configured provider. Course material is never copied into the
 * repository; it stays in the folder and the local Blitz data directory.
 */

import { readdir, stat } from "node:fs/promises"
import { createReadStream } from "node:fs"
import { basename, join } from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { api } from "../convex/_generated/api.js"
import { readChatStream } from "../lib/chat-stream.ts"
import { serverConvexClient } from "../lib/server/convex.ts"
import { findQuizBlocks } from "../lib/interactive-blocks.ts"
import { parseTeachOutline, suggestUnitTitle, TEACH_QUICK_REPLIES } from "../lib/teach.ts"

/** Parsed command-line options. */
type Options = { folder: string; match: string[]; title?: string; teach: boolean; prewarm: boolean }

/** Reads arguments, exiting with usage on invalid input. */
function parseArgs(argv: string[]): Options {
  const options: Options = { folder: "", match: [], teach: false, prewarm: false }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === "--match") options.match.push(argv[++index] ?? "")
    else if (value === "--title") options.title = argv[++index]
    else if (value === "--teach") options.teach = true
    else if (value === "--prewarm") options.prewarm = true
    else if (!options.folder) options.folder = value
  }
  if (!options.folder) {
    console.error("Usage: npm run benchmark:teach -- <folder> [--match text]... [--title name] [--teach] [--prewarm]")
    process.exit(1)
  }
  return options
}

/** Loads `.env.local` without overriding values set by the launcher. */
function loadLocalEnvironment(): void {
  try {
    process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)))
  } catch {
    // A launcher-provided environment is enough.
  }
}

/** Formats milliseconds for the report. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/** Runs the benchmark and prints a readable report plus one JSON summary line. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  loadLocalEnvironment()
  const serverUrl = process.env.BLITZ_SERVER_URL ?? `http://127.0.0.1:${process.env.BLITZ_PORT ?? "3007"}`
  const client = serverConvexClient(() => new Error("Set BLITZ_CONVEX_URL or run Blitz first"))

  const names = (await readdir(options.folder))
    .filter((name) => !name.startsWith(".") && !name.startsWith("~$"))
    .filter(
      (name) =>
        !options.match.length ||
        options.match.some((term) => name.toLowerCase().includes(term.toLowerCase()))
    )
    .sort()
  const files = []
  for (const name of names) {
    const path = join(options.folder, name)
    const info = await stat(path)
    if (info.isFile()) files.push({ name, path, size: info.size })
  }
  if (!files.length) throw new Error("No files matched")

  const title = options.title ?? `Benchmark: ${basename(options.folder)}`
  const projectId = await client.mutation(api.projects.createProject, { title })
  const unitTitle = suggestUnitTitle(files.map((file) => file.name), 1)
  const unitId = await client.mutation(api.units.create, {
    projectId,
    title: unitTitle,
    titleSource: "auto",
  })
  console.log(`Module "${title}" (${projectId}), unit "${unitTitle}"\n`)

  const importStarted = Date.now()
  const uploads: Array<{ name: string; bytes: number; ms: number; result: string }> = []
  for (const file of files) {
    const started = Date.now()
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        "x-blitz-project-id": String(projectId),
        "x-blitz-unit-id": String(unitId),
        "x-blitz-filename": encodeURIComponent(file.name),
      },
      body: Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>,
      duplex: "half",
    }
    const response = await fetch(`${serverUrl}/api/sources/upload`, init)
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const result = !response.ok
      ? `failed: ${String(payload.error ?? response.status)}`
      : payload.unsupported
        ? `unreadable: ${String(payload.extractionError ?? "unsupported")}`
        : payload.duplicate
          ? "duplicate"
          : "ready"
    uploads.push({ name: file.name, bytes: file.size, ms: Date.now() - started, result })
    console.log(`${seconds(Date.now() - started).padStart(7)}  ${result.padEnd(10)}  ${file.name}`)
  }
  const importMs = Date.now() - importStarted
  console.log(`\nUpload to ready: ${seconds(importMs)} for ${files.length} files`)

  let teach: Record<string, unknown> | undefined
  if (options.teach) {
    const { chatId } = await client.mutation(api.units.startTeach, { unitId })
    const started = Date.now()
    let firstDelta: number | undefined
    let failure: string | undefined
    // Sent alongside the turn, not awaited, matching the Teach screen.
    if (options.prewarm)
      void fetch(`${serverUrl}/api/teach/prewarm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId }),
      }).catch(() => undefined)
    const response = await fetch(`${serverUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatId,
        message: TEACH_QUICK_REPLIES.start,
        clientMessageId: `benchmark-${Date.now()}`,
        projectIds: [],
        attachments: [],
      }),
    })
    if (!response.ok || !response.body) throw new Error(`Teach turn failed: HTTP ${response.status}`)
    await readChatStream(response.body, (value) => {
      const event = value as { type?: string; message?: string }
      if (event.type === "delta" && firstDelta === undefined) {
        firstDelta = Date.now() - started
        console.log(`\nFirst words after ${seconds(firstDelta)}`)
      }
      if (event.type === "error") failure = event.message
    })
    const totalMs = Date.now() - started
    const chat = await client.query(api.workspaceChats.get, { chatId })
    const reply = chat?.messages.findLast((message) => message.role === "assistant")
    const outline = reply ? parseTeachOutline(reply.content) : undefined
    teach = {
      prewarm: options.prewarm,
      firstWordsMs: firstDelta ?? null,
      firstSectionMs: totalMs,
      failure: failure ?? null,
      outlineSections: outline?.sections.length ?? 0,
      quizzes: reply ? findQuizBlocks(reply.content).length : 0,
      citations: reply?.citations.length ?? 0,
      replyCharacters: reply?.content.length ?? 0,
    }
    console.log(
      failure
        ? `Teach failed after ${seconds(totalMs)}: ${failure}`
        : `First section finished after ${seconds(totalMs)}: ${outline?.sections.length ?? 0} sections planned, ${teach.quizzes} quizzes`
    )
    console.log(`Open ${serverUrl}/projects/${projectId}/learn/${unitId}`)
  }
  console.log(
    `\n${JSON.stringify({ projectId, unitId, files: files.length, importMs, uploads, teach })}`
  )
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
