/**
 * The Blitz operations behind the MCP tools: reading the Library, Today and a
 * module's units, creating modules, and adding material to a unit. It talks to
 * the running app the same way the web client does: Convex queries and
 * mutations for data, and the Next upload routes for files, so every source
 * goes through the usual extraction, chunking and Teach preparation.
 */

import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { basename, dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { ConvexHttpClient } from "convex/browser"
import { anyApi } from "convex/server"

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Largest local file the tool will upload; matches what Teach can usefully read. */
const MAX_FILE_BYTES = 100 * 1024 * 1024

/** Content types for the formats Blitz extracts, keyed by file extension. */
const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

/** A failure the agent should read as-is, such as an unknown module or a stopped app. */
export class BlitzError extends Error {}

/**
 * Finds the Convex deployment: `BLITZ_CONVEX_URL`, else the local deployment's
 * saved port (the desktop shell and `dev:lan` both use it), else `.env.local`.
 */
async function convexUrl() {
  if (process.env.BLITZ_CONVEX_URL) return process.env.BLITZ_CONVEX_URL
  const config = await readFile(
    join(ROOT, ".convex", "local", "default", "config.json"),
    "utf8"
  ).catch(() => "")
  const port = config ? JSON.parse(config).ports?.cloud : undefined
  if (port) return `http://127.0.0.1:${port}`
  const env = await readFile(join(ROOT, ".env.local"), "utf8").catch(() => "")
  const match = env.match(/^NEXT_PUBLIC_CONVEX_URL=(.+)$/m)
  if (match) return match[1].trim()
  throw new BlitzError(
    "Blitz has no local Convex deployment yet. Run it once with `npm run dev:lan`."
  )
}

/**
 * Finds the running web app: `BLITZ_URL`, else whichever of the LAN launcher
 * (3007) and the desktop shell (3008) answers its health check.
 */
async function appUrl() {
  const candidates = process.env.BLITZ_URL
    ? [process.env.BLITZ_URL]
    : ["http://127.0.0.1:3007", "http://127.0.0.1:3008"]
  for (const base of candidates) {
    const healthy = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(3000),
    })
      .then((response) => response.ok)
      .catch(() => false)
    if (healthy) return base.replace(/\/$/, "")
  }
  throw new BlitzError(
    "Blitz isn't running on this Mac. Start it with `npm run dev:lan` or the desktop app."
  )
}

/**
 * The address links should use, so they open on the phone too: the Mac's
 * Tailscale name when it has one (`BLITZ_PUBLIC_URL` overrides), else the app's own.
 */
async function publicUrl(app) {
  if (process.env.BLITZ_PUBLIC_URL)
    return process.env.BLITZ_PUBLIC_URL.replace(/\/$/, "")
  const port = new URL(app).port
  const status = await run("tailscale", ["status", "--json"], { timeout: 3000 })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch(() => null)
  const name = status?.Self?.DNSName?.replace(/\.$/, "")
  return name ? `http://${name}:${port}` : app
}

/**
 * Connects to the running Blitz. Each tool call connects afresh, so a Blitz
 * started after the agent still works.
 */
export async function connect() {
  const [convex, app] = await Promise.all([
    convexUrl().then((url) => new ConvexHttpClient(url)),
    appUrl(),
  ])
  return { convex, app, links: await publicUrl(app) }
}

/** Reads a JSON `error` from a failed response, with a fallback. */
async function responseError(response, fallback) {
  const body = await response.json().catch(() => null)
  return typeof body?.error === "string" ? body.error : fallback
}

/** Every module (project) in the Library, newest first. */
async function modules(blitz) {
  const response = await fetch(`${blitz.app}/api/projects`)
  if (!response.ok)
    throw new BlitzError(
      await responseError(response, "Blitz couldn't list its modules.")
    )
  return response.json()
}

/**
 * Resolves a module named by id or title: an exact title first, then the only
 * title containing the words given.
 * @throws BlitzError naming the candidates when none or several match.
 */
export async function findModule(blitz, name) {
  const all = await modules(blitz)
  const wanted = String(name ?? "")
    .trim()
    .toLowerCase()
  const exact = all.filter(
    (item) => item.id === name || item.title.toLowerCase() === wanted
  )
  if (exact.length === 1) return exact[0]
  const partial = all.filter((item) =>
    item.title.toLowerCase().includes(wanted)
  )
  if (wanted && partial.length === 1) return partial[0]
  const titles = (partial.length ? partial : all)
    .map((item) => `"${item.title}"`)
    .join(", ")
  throw new BlitzError(
    partial.length > 1
      ? `Several modules match "${name}": ${titles}.`
      : `No module matches "${name}". Modules: ${titles}.`
  )
}

/** Share of a unit taught, from its Teach summary, as a whole percentage. */
function taught(teach) {
  if (!teach?.sectionCount) return 0
  if (teach.completed) return 100
  return Math.round(
    (100 * Math.min(teach.taughtSectionIds.length, teach.sectionCount)) /
      teach.sectionCount
  )
}

/** Today's summary as on the Library: streak, XP against the goal, what's due and the lesson to continue. */
export async function today(blitz) {
  const summary = await blitz.convex.query(anyApi.progress.today, {
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    now: Math.floor(Date.now() / 60_000) * 60_000,
  })
  const lines = [
    `Streak: ${summary.streak.current} day${summary.streak.current === 1 ? "" : "s"} (longest ${summary.streak.longest})${summary.streak.todayMet ? ", today's goal met" : ""}.`,
    `Today: ${summary.todayXp}/${summary.goal} XP, ${summary.answeredToday} questions answered, ${summary.sectionsToday} sections taught.`,
    `Concepts due for review: ${summary.dueConcepts}. Review: ${blitz.links}/review`,
  ]
  if (summary.resume) {
    const { projectId, projectTitle, unitId, unitTitle, detail } =
      summary.resume
    lines.push(
      `Continue: ${projectTitle} › ${unitTitle} (${detail}). ${blitz.links}/projects/${projectId}/learn/${unitId}`
    )
  }
  return lines.join("\n")
}

/** The Library: each module with its units' Teach progress and what to study next. */
export async function listModules(blitz) {
  const [all, progress] = await Promise.all([
    modules(blitz),
    blitz.convex.query(anyApi.units.libraryProgress, {}),
  ])
  if (!all.length) return "The Library is empty."
  return all
    .map((item) => {
      const state = progress[item.id]
      const units = state?.unitCount
        ? `${state.unitCount} unit${state.unitCount === 1 ? "" : "s"}, ${state.taughtCount} finished` +
          (state.nextUnitTitle ? `, next: ${state.nextUnitTitle}` : "")
        : state?.hasUnsortedSources
          ? "sources not grouped into units yet"
          : "no material yet"
      return `- ${item.title} (${units}) · id ${item.id} · ${blitz.links}/projects/${item.id}`
    })
    .join("\n")
}

/** One module's learning path: each unit with its sources and Teach progress, plus unsorted and reference sources. */
export async function readModule(blitz, name) {
  const found = await findModule(blitz, name)
  const path = await blitz.convex.query(anyApi.units.listForProject, {
    projectId: found.id,
  })
  const source = (item) =>
    `  - ${item.filename}${item.status === "ready" ? "" : ` (${item.status})`}${item.unsupported ? " (unreadable)" : ""}${item.error ? `: ${item.error}` : ""}`
  const lines = [`${found.title} · ${blitz.links}/projects/${found.id}`]
  if (!path.units.length) lines.push("No units yet.")
  for (const unit of path.units) {
    const teach = unit.teach?.currentSectionTitle
      ? `, now on "${unit.teach.currentSectionTitle}"`
      : ""
    lines.push(
      `- ${unit.title} (${taught(unit.teach)}% taught${teach}) · id ${unit.id} · ${blitz.links}/projects/${found.id}/learn/${unit.id}`
    )
    lines.push(...unit.sources.map(source))
  }
  if (path.unsortedSources.length)
    lines.push("Not in a unit yet:", ...path.unsortedSources.map(source))
  if (path.referenceSources.length)
    lines.push(
      "Reference books (back up every unit):",
      ...path.referenceSources.map(source)
    )
  return lines.join("\n")
}

/** Creates an empty module and returns where to find it. */
export async function createModule(blitz, title) {
  const clean = String(title ?? "").trim()
  if (!clean) throw new BlitzError("A module needs a title.")
  const response = await fetch(`${blitz.app}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "create", title: clean }),
  })
  if (!response.ok)
    throw new BlitzError(
      await responseError(response, "Blitz couldn't create the module.")
    )
  const { id } = await response.json()
  return `Created "${clean}" · id ${id} · ${blitz.links}/projects/${id}`
}

/** Uploads one body to a unit through the app's upload route and says how it went. */
async function upload(
  blitz,
  { projectId, unitId, filename, body, contentType, sourceUrl }
) {
  const response = await fetch(`${blitz.app}/api/sources/upload`, {
    method: "POST",
    headers: {
      "x-blitz-project-id": projectId,
      "x-blitz-unit-id": unitId,
      "x-blitz-filename": encodeURIComponent(filename),
      ...(sourceUrl
        ? { "x-blitz-source-url": encodeURIComponent(sourceUrl) }
        : {}),
      ...(contentType ? { "content-type": contentType } : {}),
    },
    body,
  })
  if (!response.ok)
    return {
      filename,
      ok: false,
      note: await responseError(response, "the upload failed"),
    }
  const result = await response.json()
  if (result.unsupported)
    return {
      filename,
      ok: false,
      note: result.extractionError || "Blitz can't read this file type",
    }
  if (result.duplicate)
    return {
      filename,
      ok: result.unitId === unitId,
      note:
        result.unitId === unitId
          ? "already in this unit"
          : "already in another unit of this module",
    }
  return {
    filename,
    ok: true,
    note: result.reference
      ? "saved as a reference book that backs up every unit"
      : "added",
  }
}

/** Picks a file name for a fetched link: its last path segment, with an extension matching what came back. */
function linkFilename(url, contentType) {
  const type = contentType.split(";")[0].trim()
  const extension =
    type === "application/pdf"
      ? ".pdf"
      : type.includes("presentationml")
        ? ".pptx"
        : type === "text/html" || type === "application/xhtml+xml"
          ? ".html"
          : type.includes("markdown")
            ? ".md"
            : ".txt"
  const segment =
    decodeURIComponent(
      new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""
    ) || new URL(url).hostname
  return `${segment.replace(/\.(pdf|pptx|html?|md|markdown|txt)$/i, "")}${extension}`
}

/**
 * Adds files, public links and notes to a unit, creating the unit when no
 * existing one matches. Each item is reported separately, so one bad link
 * doesn't lose the rest.
 */
export async function addMaterial(blitz, input) {
  const found = await findModule(blitz, input.module)
  const files = Array.isArray(input.files) ? input.files : []
  const links = Array.isArray(input.links) ? input.links : []
  const notes =
    typeof input.notes === "string" && input.notes.trim()
      ? input.notes.trim()
      : ""
  if (!files.length && !links.length && !notes)
    throw new BlitzError("Give at least one file, link or notes to add.")
  const unitName = String(input.unit ?? "").trim()
  if (!unitName)
    throw new BlitzError(
      "Say which unit it goes in: an existing unit's title, or a title for a new one."
    )

  // An existing unit by id or title, else a new one at the end of the path.
  const path = await blitz.convex.query(anyApi.units.listForProject, {
    projectId: found.id,
  })
  const existing = path.units.find(
    (unit) =>
      unit.id === unitName ||
      unit.title.toLowerCase() === unitName.toLowerCase()
  )
  const unitId =
    existing?.id ??
    (await blitz.convex.mutation(anyApi.units.create, {
      projectId: found.id,
      title: unitName,
    }))

  const results = []
  for (const file of files) {
    const location = resolve(
      String(file).replace(/^~(?=\/)/, process.env.HOME ?? "~")
    )
    const info = await stat(location).catch(() => null)
    if (!info?.isFile())
      results.push({
        filename: basename(location),
        ok: false,
        note: "no such file",
      })
    else if (info.size > MAX_FILE_BYTES)
      results.push({
        filename: basename(location),
        ok: false,
        note: "larger than 100 MB",
      })
    else
      results.push(
        await upload(blitz, {
          projectId: found.id,
          unitId,
          filename: basename(location),
          body: await readFile(location),
          contentType: CONTENT_TYPES[extname(location).toLowerCase()],
        })
      )
  }
  for (const link of links) {
    // The app's fetch route refuses private addresses and formats it can't read.
    const response = await fetch(`${blitz.app}/api/sources/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: String(link) }),
    })
    if (!response.ok) {
      results.push({
        filename: String(link),
        ok: false,
        note: await responseError(response, "the link couldn't be fetched"),
      })
      continue
    }
    const finalUrl = response.headers.get("x-source-url") ?? String(link)
    const contentType = response.headers.get("content-type") ?? "text/plain"
    // Course sites answer a signed-out download with their sign-in page; that page isn't material.
    if (
      contentType.startsWith("text/html") &&
      /\/(login|signin|sign-in|sso|cas|auth)\b/i.test(
        new URL(finalUrl).pathname
      )
    ) {
      results.push({
        filename: String(link),
        ok: false,
        note: "it needs a sign-in; download it to a file first",
      })
      continue
    }
    results.push(
      await upload(blitz, {
        projectId: found.id,
        unitId,
        filename: linkFilename(finalUrl, contentType),
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: contentType.split(";")[0],
        sourceUrl: finalUrl,
      })
    )
  }
  if (notes) {
    const title =
      String(input.notes_title ?? "").trim() ||
      notes
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .trim()
        .slice(0, 60) ||
      "Notes"
    results.push(
      await upload(blitz, {
        projectId: found.id,
        unitId,
        filename: `${title}.md`,
        body: notes,
        contentType: "text/markdown",
      })
    )
  }

  const added = results.filter((result) => result.ok).length
  const unitTitle = existing?.title ?? unitName
  // A new unit that received nothing is empty; remove it, as the web dialog does.
  if (!existing && !added) {
    await blitz.convex
      .mutation(anyApi.units.remove, { unitId })
      .catch(() => undefined)
    return [
      `Nothing was added to ${found.title}, so no unit was created.`,
      ...results.map((result) => `- ${result.filename}: ${result.note}`),
    ].join("\n")
  }
  return [
    `${added} of ${results.length} added to ${found.title} › ${unitTitle}${existing ? "" : " (new unit)"}. Teach it: ${blitz.links}/projects/${found.id}/learn/${unitId}`,
    ...results.map((result) => `- ${result.filename}: ${result.note}`),
  ].join("\n")
}
