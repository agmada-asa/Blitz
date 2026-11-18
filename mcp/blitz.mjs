/**
 * The Blitz operations behind the MCP tools: reading the Library, Today, a
 * module's units and the gaps in its weeks, recent material, weak concepts and
 * exam papers; creating modules, adding material to a unit, updating a unit's
 * lesson from files that arrived after it was planned, and tidying modules,
 * units and sources without deleting anything. It talks to
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
export async function responseError(response, fallback) {
  const body = await response.json().catch(() => null)
  return typeof body?.error === "string" ? body.error : fallback
}

/** Every module (project) in the Library, newest first. */
export async function modules(blitz) {
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

/**
 * The ids of archived modules. The app's projects route leaves the archive
 * state out, so it's read from Convex directly.
 *
 * @returns A set of module ids.
 */
async function archivedIds(blitz) {
  const projects = await blitz.convex.query(anyApi.projects.listProjects, {})
  return new Set(
    projects
      .filter((project) => project.archivedAt)
      .map((project) => String(project._id))
  )
}

/**
 * Reads the week a unit covers from its title, such as "Week 4: Normalisation",
 * "Wk 4" or "W8 NoSQL".
 *
 * @param title The unit's title.
 * @returns The week number, or null when the title doesn't name one.
 */
export function weekOf(title) {
  const match = String(title).match(/\b(?:week|wk|w)\s*0?(\d{1,2})\b/i)
  return match ? Number(match[1]) : null
}

/**
 * Finds the holes in a module's weeks: week numbers between its first and last
 * numbered unit that have no unit, and numbered units not yet taught although
 * a later week has been.
 *
 * @param units Units with `week` (or null) and `taught` (a percentage).
 * @returns The first and last week, `missing` and `untaught` week numbers in
 *   order; null when fewer than two units name a week.
 */
export function gapsOf(units) {
  const numbered = units.filter((unit) => unit.week !== null)
  if (numbered.length < 2) return null
  const weeks = new Set(numbered.map((unit) => unit.week))
  const first = Math.min(...weeks)
  const last = Math.max(...weeks)
  const missing = []
  for (let week = first + 1; week < last; week += 1)
    if (!weeks.has(week)) missing.push(week)
  const latestTaught = Math.max(
    -Infinity,
    ...numbered.filter((unit) => unit.taught > 0).map((unit) => unit.week)
  )
  const untaught = [
    ...new Set(
      numbered
        .filter((unit) => unit.taught === 0 && unit.week < latestTaught)
        .map((unit) => unit.week)
    ),
  ].sort((a, b) => a - b)
  return { first, last, missing, untaught }
}

/**
 * Describes a list of week numbers, joining runs: [1, 2, 6, 7, 9] reads "1–2, 6–7 and 9".
 *
 * @param weeks Week numbers in order.
 * @returns The description.
 */
export function describeWeeks(weeks) {
  const runs = []
  for (const week of weeks) {
    const run = runs.at(-1)
    if (run && week === run[1] + 1) run[1] = week
    else runs.push([week, week])
  }
  const parts = runs.map(([from, to]) => (from === to ? `${from}` : `${from}–${to}`))
  return parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
    : (parts[0] ?? "")
}

/**
 * Says what a module's gaps are, in a sentence.
 *
 * @param gaps The result of `gapsOf`.
 * @returns The sentence, or an empty string when there are none.
 */
function gapsText(gaps) {
  if (!gaps) return ""
  const parts = []
  if (gaps.missing.length)
    parts.push(
      `week${gaps.missing.length === 1 ? "" : "s"} ${describeWeeks(gaps.missing)} ${gaps.missing.length === 1 ? "has" : "have"} no unit`
    )
  if (gaps.untaught.length)
    parts.push(
      `week${gaps.untaught.length === 1 ? "" : "s"} ${describeWeeks(gaps.untaught)} ${gaps.untaught.length === 1 ? "isn't" : "aren't"} taught yet although later weeks are`
    )
  return parts.length ? `Gaps: ${parts.join("; ")}.` : ""
}

/** Share of a unit taught, from its Teach summary, as a whole percentage. */
export function taught(teach) {
  if (!teach?.sectionCount) return 0
  if (teach.completed) return 100
  return Math.round(
    (100 * Math.min(teach.taughtSectionIds.length, teach.sectionCount)) /
      teach.sectionCount
  )
}

/** The current time, to the minute, which is as finely as Blitz's summaries change. */
const thisMinute = () => Math.floor(Date.now() / 60_000) * 60_000

/** Today's summary from Convex, for this Mac's time zone and the current minute. */
export function todaySummary(blitz) {
  return blitz.convex.query(anyApi.progress.today, {
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    now: thisMinute(),
  })
}

/**
 * Today's summary as on the Library: streak, XP against the goal, what's due and the lesson to continue.
 *
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 */
export async function today(blitz) {
  const [summary, library] = await Promise.all([
    todaySummary(blitz),
    libraryState(blitz),
  ])
  // Where the due concepts are, most first, so a review can start where most is waiting.
  const dueByModule = library
    .filter((item) => item.due && !item.archived)
    .sort((a, b) => b.due - a.due)
    .map(({ id, title, due }) => ({ id, title, due }))
  const lines = [
    `Streak: ${summary.streak.current} day${summary.streak.current === 1 ? "" : "s"} (longest ${summary.streak.longest})${summary.streak.todayMet ? ", today's goal met" : ""}.`,
    `Today: ${summary.todayXp}/${summary.goal} XP, ${summary.answeredToday} questions answered, ${summary.sectionsToday} sections taught.`,
    `Concepts due for review: ${summary.dueConcepts}. Review: ${blitz.links}/review`,
  ]
  if (dueByModule.length)
    lines.push(
      `Due by module: ${dueByModule.map((item) => `${item.title} ${item.due}`).join(", ")}.`
    )
  if (summary.resume) {
    const { projectId, projectTitle, unitId, unitTitle, detail } =
      summary.resume
    lines.push(
      `Continue: ${projectTitle} › ${unitTitle} (${detail}). ${blitz.links}/projects/${projectId}/learn/${unitId}`
    )
  }
  return {
    text: lines.join("\n"),
    data: {
      links: blitz.links,
      xp: summary.todayXp,
      goal: summary.goal,
      streak: summary.streak.current,
      longest: summary.streak.longest,
      goalMet: summary.streak.todayMet,
      answered: summary.answeredToday,
      sections: summary.sectionsToday,
      due: summary.dueConcepts,
      week: summary.week,
      dueByModule,
      resume: summary.resume
        ? {
            module: summary.resume.projectId,
            moduleTitle: summary.resume.projectTitle,
            unit: summary.resume.unitId,
            unitTitle: summary.resume.unitTitle,
            detail: summary.resume.detail,
          }
        : null,
    },
  }
}

/**
 * The Library: each module with its units' Teach progress and what to study next.
 * Recently studied modules come first, then the rest newest first, as the Library
 * orders them. The sort is stable, so modules never studied keep that order.
 *
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 */
export async function listModules(blitz) {
  const list = await libraryState(blitz)
  /** One module as a line for the agent. */
  const line = (item) => {
    const units = item.units
      ? `${item.units} unit${item.units === 1 ? "" : "s"}, ${item.finished} finished` +
        (item.next ? `, next: ${item.next}` : "")
      : item.unsorted
        ? "sources not grouped into units yet"
        : "no material yet"
    const due = item.due ? `, ${item.due} due for review` : ""
    return `- ${item.title} (${units}${due}) · id ${item.id} · ${blitz.links}/projects/${item.id}`
  }
  const active = list.filter((item) => !item.archived)
  const archived = list.filter((item) => item.archived)
  const lines = active.map(line)
  if (archived.length) lines.push("Archived:", ...archived.map(line))
  return {
    text: lines.join("\n") || "The Library is empty.",
    data: { links: blitz.links, modules: list },
  }
}

/**
 * Every module with its units' Teach progress, concepts due for review and
 * archive state. Recently studied modules come first, then the rest newest
 * first, as the Library orders them; archived modules go last.
 *
 * @returns The modules, in that order.
 */
async function libraryState(blitz) {
  const [all, progress, archived] = await Promise.all([
    modules(blitz),
    blitz.convex.query(anyApi.units.libraryProgress, { now: thisMinute() }),
    archivedIds(blitz),
  ])
  return all
    .map((item) => {
      const state = progress[item.id]
      return {
        id: item.id,
        title: item.title,
        units: state?.unitCount ?? 0,
        finished: state?.taughtCount ?? 0,
        next: state?.nextUnitTitle ?? null,
        unsorted: Boolean(state?.hasUnsortedSources),
        lastStudiedAt: state?.lastStudiedAt || null,
        progress: state?.unitProgress?.length
          ? state.unitProgress.reduce((sum, share) => sum + share, 0) /
            state.unitProgress.length
          : 0,
        due: state?.dueCount ?? 0,
        archived: archived.has(item.id),
      }
    })
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        (b.lastStudiedAt ?? 0) - (a.lastStudiedAt ?? 0)
    )
}

/** Mirrors `TEACH_UPDATE_LEASE_MS` in `lib/teach-updates.ts`, which plain Node can't import. */
const UPDATE_LEASE_MS = 10 * 60 * 1000

/**
 * What a unit's lesson is waiting for, as `readModule` reports it.
 *
 * @param teach The unit's Teach summary.
 * @returns New files, whether an update is running and why one failed; null for a unit with no outline yet.
 */
function updateItem(teach) {
  const update = teach?.update
  if (!update) return null
  return {
    newFiles: update.newSources.map((source) => source.filename),
    running:
      update.run?.status === "running" &&
      update.run.startedAt > Date.now() - UPDATE_LEASE_MS,
    waitingSections: update.pendingSections.length,
    error: update.run?.status === "failed" ? (update.run.error ?? "") : null,
  }
}

/** One source of a module, as `readModule` reports it. */
function sourceItem(source) {
  return {
    id: source.id,
    name: source.filename,
    status: source.status,
    unreadable: Boolean(source.unsupported),
    error: source.error ?? null,
    addedAt: source.createdAt,
  }
}

/**
 * One module's learning path: each unit with its sources and Teach progress,
 * plus unsorted and reference sources and the module's practice summary.
 *
 * @param name The module's id or title.
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 * @throws BlitzError when no module, or more than one, matches.
 */
export async function readModule(blitz, name) {
  const found = await findModule(blitz, name)
  const [path, practice, archived] = await Promise.all([
    blitz.convex.query(anyApi.units.listForProject, { projectId: found.id }),
    blitz.convex.query(anyApi.practice.overview, {
      projectId: found.id,
      now: thisMinute(),
    }),
    archivedIds(blitz),
  ])
  const questions = new Map(practice.units.map((unit) => [unit.id, unit]))
  const units = path.units.map((unit) => {
    const drill = questions.get(unit.id)
    return {
      id: unit.id,
      title: unit.title,
      week: weekOf(unit.title),
      taught: taught(unit.teach),
      started: Boolean(unit.teach),
      section: unit.teach?.currentSectionTitle ?? null,
      sectionIndex: unit.teach?.sectionCount ? unit.teach.sectionIndex : null,
      sectionCount: unit.teach?.sectionCount ?? 0,
      questions: drill?.questionCount ?? 0,
      answered: drill?.answeredCount ?? 0,
      correct: drill?.correctCount ?? 0,
      addedAt: Math.max(0, ...unit.sources.map((source) => source.createdAt)) || null,
      sources: unit.sources.map(sourceItem),
      update: updateItem(unit.teach),
    }
  })
  const data = {
    id: found.id,
    title: found.title,
    archived: archived.has(found.id),
    links: blitz.links,
    units,
    gaps: gapsOf(units),
    unsorted: path.unsortedSources.map(sourceItem),
    references: path.referenceSources.map(sourceItem),
    practice: {
      due: practice.dueConceptCount,
      missed: practice.missedCount,
      unanswered: practice.unansweredCount,
      weak: practice.weakConcepts.map((concept) => ({
        title: concept.title,
        unit: concept.unitTitle,
        accuracy: concept.accuracy,
      })),
    },
  }

  const source = (item) =>
    `  - ${item.name}${item.status === "ready" ? "" : ` (${item.status})`}${item.unreadable ? " (unreadable)" : ""}${item.error ? `: ${item.error}` : ""}`
  const lines = [
    `${data.title}${data.archived ? " (archived)" : ""} · ${blitz.links}/projects/${data.id}`,
  ]
  if (!data.units.length) lines.push("No units yet.")
  const gaps = gapsText(data.gaps)
  if (gaps) lines.push(gaps)
  for (const unit of data.units) {
    const teach = unit.section ? `, now on "${unit.section}"` : ""
    lines.push(
      `- ${unit.title} (${unit.taught}% taught${teach}) · id ${unit.id} · ${blitz.links}/projects/${data.id}/learn/${unit.id}`
    )
    lines.push(...unit.sources.map(source))
    if (unit.update?.running) lines.push("  The lesson is being updated from new material.")
    else if (unit.update?.newFiles.length)
      lines.push(
        `  Not in the lesson yet: ${unit.update.newFiles.join(", ")}. Update it with update_unit.`
      )
    if (unit.update?.error) lines.push(`  The last update failed: ${unit.update.error}`)
    if (unit.update?.waitingSections)
      lines.push(
        `  ${unit.update.waitingSections} section${unit.update.waitingSections === 1 ? "" : "s"} waiting to be taught from new material.`
      )
  }
  if (data.unsorted.length)
    lines.push("Not in a unit yet:", ...data.unsorted.map(source))
  if (data.references.length)
    lines.push(
      "Reference books (back up every unit):",
      ...data.references.map(source)
    )
  if (data.practice.due)
    lines.push(`${data.practice.due} concept${data.practice.due === 1 ? "" : "s"} due for review.`)
  return { text: lines.join("\n"), data }
}

/** How far back `recent_material` looks by default, in days. */
const RECENT_DAYS = 7

/**
 * Material added recently across the Library: each unit (or a module's
 * unsorted pile) that received sources in the last `days`, with how many and
 * whether the unit has been taught or is waiting for a lesson update.
 *
 * @param input.days How many days back to look, 1 to 60. Optional: 7.
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 */
export async function recentMaterial(blitz, input = {}) {
  const days = Math.min(60, Math.max(1, Math.round(Number(input.days) || RECENT_DAYS)))
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const [all, archived] = await Promise.all([modules(blitz), archivedIds(blitz)])
  const active = all.filter((item) => !archived.has(item.id))
  const paths = await Promise.all(
    active.map((item) =>
      blitz.convex.query(anyApi.units.listForProject, { projectId: item.id })
    )
  )
  const items = []
  active.forEach((module, index) => {
    const path = paths[index]
    for (const unit of path.units) {
      const fresh = unit.sources.filter((source) => source.createdAt >= since)
      if (!fresh.length) continue
      items.push({
        module: module.id,
        moduleTitle: module.title,
        unit: unit.id,
        unitTitle: unit.title,
        added: fresh.length,
        addedAt: Math.max(...fresh.map((source) => source.createdAt)),
        taught: taught(unit.teach),
        started: Boolean(unit.teach),
        // Files added after the lesson was planned wait for update_unit.
        notInLesson: unit.teach?.update?.newSources.length ?? 0,
      })
    }
    const unsorted = path.unsortedSources.filter((source) => source.createdAt >= since)
    if (unsorted.length)
      items.push({
        module: module.id,
        moduleTitle: module.title,
        unit: null,
        unitTitle: null,
        added: unsorted.length,
        addedAt: Math.max(...unsorted.map((source) => source.createdAt)),
        taught: 0,
        started: false,
        notInLesson: 0,
      })
  })
  items.sort((a, b) => b.addedAt - a.addedAt)
  const text = items.map((item) => {
    const where = item.unit ? `${item.moduleTitle} › ${item.unitTitle}` : `${item.moduleTitle} (not in a unit yet)`
    const state = !item.unit
      ? "sort into a unit first"
      : item.notInLesson
        ? `${item.notInLesson} not in its lesson yet: update_unit`
        : item.taught === 100
          ? "taught"
          : item.taught
            ? `${item.taught}% taught`
            : item.started
              ? "lesson started"
              : "not taught yet"
    return `- ${where}: ${item.added} file${item.added === 1 ? "" : "s"} added, ${state}`
  })
  return {
    text: text.length
      ? [`Added in the last ${days} day${days === 1 ? "" : "s"}:`, ...text].join("\n")
      : `Nothing added in the last ${days} day${days === 1 ? "" : "s"}.`,
    data: { links: blitz.links, days, items },
  }
}

/** Most weak concepts `weak_concepts` lists by default. */
const WEAK_LIMIT = 10

/**
 * The concepts that aren't sticking, across every module or one: those Blitz
 * rates weak from their answers, lowest accuracy first.
 *
 * @param input.module A module's title or id. Optional: every module that isn't archived.
 * @param input.limit How many to list, 1 to 50. Optional: 10.
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 */
export async function weakConcepts(blitz, input = {}) {
  const limit = Math.min(50, Math.max(1, Math.round(Number(input.limit) || WEAK_LIMIT)))
  let scope
  if (input.module) scope = [await findModule(blitz, input.module)]
  else {
    const [all, archived] = await Promise.all([modules(blitz), archivedIds(blitz)])
    scope = all.filter((item) => !archived.has(item.id))
  }
  const overviews = await Promise.all(
    scope.map((item) =>
      blitz.convex.query(anyApi.practice.overview, {
        projectId: item.id,
        now: thisMinute(),
      })
    )
  )
  const concepts = scope
    .flatMap((module, index) =>
      overviews[index].weakConcepts.map((concept) => ({
        title: concept.title,
        module: module.id,
        moduleTitle: module.title,
        unit: concept.unitId,
        unitTitle: concept.unitTitle,
        accuracy: concept.accuracy,
        attempts: concept.attempts,
      }))
    )
    // Lowest accuracy first; among equals, the one answered most, since that's the surest.
    .sort(
      (a, b) =>
        (a.accuracy ?? 1) - (b.accuracy ?? 1) || b.attempts - a.attempts
    )
    .slice(0, limit)
  const text = concepts.map(
    (concept) =>
      `- ${concept.title} (${concept.moduleTitle} › ${concept.unitTitle})${concept.accuracy === null ? "" : `: ${Math.round(concept.accuracy * 100)}% right over ${concept.attempts} answer${concept.attempts === 1 ? "" : "s"}`}`
  )
  return {
    text: text.length
      ? ["Concepts not sticking yet, weakest first:", ...text].join("\n")
      : "No weak concepts: nothing answered has been missed often enough to count.",
    data: { links: blitz.links, concepts },
  }
}

/**
 * Exam preparation for a module: Blitz's readiness estimate and its past and
 * mock papers with their best scores.
 *
 * @param name The module's title or id.
 * @returns The same reading as `text` for an agent and `data` for a client with a UI.
 */
export async function exams(blitz, name) {
  const found = await findModule(blitz, name)
  const [papers, ready] = await Promise.all([
    blitz.convex.query(anyApi.exam.listPapers, { projectId: found.id }),
    blitz.convex.query(anyApi.progress.readiness, {
      projectId: found.id,
      now: thisMinute(),
    }),
  ])
  const list = papers.map((paper) => ({
    id: paper.id,
    title: paper.title,
    kind: paper.kind,
    status: paper.status,
    questions: paper.questionCount,
    marks: paper.totalMarks,
    minutes: paper.durationMinutes,
    best: paper.bestPercentage,
    attempts: paper.attemptCount,
    inProgress: Boolean(paper.inProgressAttemptId),
  }))
  const readiness = {
    share: ready.readiness,
    concepts: ready.concepts,
    practised: ready.practised,
  }
  const lines = [
    `${found.title} exam readiness: ${Math.round(readiness.share * 100)}% (of ${readiness.concepts} concepts, ${readiness.practised} practised). Exam prep: ${blitz.links}/projects/${found.id}/practice`,
  ]
  if (!list.length) lines.push("No past or mock papers yet. Import past papers in exam mode.")
  for (const paper of list)
    lines.push(
      `- ${paper.title} (${paper.kind === "mock" ? "mock" : "past paper"}, ${paper.questions} question${paper.questions === 1 ? "" : "s"}${paper.marks ? `, ${paper.marks} marks` : ""}${paper.status === "ready" ? "" : `, ${paper.status}`})` +
        (paper.attempts
          ? `: best ${paper.best ?? "?"}% over ${paper.attempts} attempt${paper.attempts === 1 ? "" : "s"}`
          : ": not sat yet") +
        (paper.inProgress ? ", one attempt in progress" : "")
    )
  return {
    text: lines.join("\n"),
    data: { id: found.id, title: found.title, links: blitz.links, readiness, papers: list },
  }
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
  const outcome = [
    `${added} of ${results.length} added to ${found.title} › ${unitTitle}${existing ? "" : " (new unit)"}. Teach it: ${blitz.links}/projects/${found.id}/learn/${unitId}`,
    ...results.map((result) => `- ${result.filename}: ${result.note}`),
  ]
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
  // A unit that already has a lesson doesn't use new files until it is updated.
  if (existing && added) {
    if (input.update_lesson)
      // The material is already in; a failed update mustn't read as a failed upload.
      outcome.push(
        await startUpdate(blitz, unitId, unitTitle).catch(
          (error) =>
            `The lesson update didn't start: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    else {
      const after = await blitz.convex.query(anyApi.units.listForProject, {
        projectId: found.id,
      })
      const fresh = after.units.find((unit) => unit.id === unitId)?.teach?.update?.newSources
      if (fresh?.length)
        outcome.push(
          `This unit already has a lesson, and ${fresh.length === 1 ? "this file isn't" : "these files aren't"} in it yet. Call update_unit to update it, or ask the user first if they'd rather choose.`
        )
    }
  }
  return outcome.join("\n")
}

/**
 * Asks Blitz to update a unit's lesson and says what happened. The update runs in
 * the app; this returns as soon as it has started, so a slow analysis can't time out.
 *
 * @returns A sentence for the agent.
 * @throws BlitzError when the request itself fails.
 */
async function startUpdate(blitz, unitId, unitTitle) {
  const response = await fetch(`${blitz.app}/api/teach/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unitId }),
  })
  if (!response.ok)
    throw new BlitzError(
      await responseError(response, "Blitz couldn't start the lesson update.")
    )
  const { status } = await response.json()
  const messages = {
    started: `Updating ${unitTitle}'s lesson from its new files. It runs in the background: read_module shows when it has finished, and progress and past answers are kept.`,
    running: `${unitTitle}'s lesson is already being updated.`,
    busy: `${unitTitle}'s tutor is writing a reply. Try update_unit again in a moment.`,
    "up-to-date": `${unitTitle}'s lesson already covers every file in the unit.`,
    "no-lesson": `${unitTitle} has no lesson yet. It will use every file in the unit when it's first taught, so there's nothing to update.`,
  }
  return messages[status] ?? `Blitz reported "${status}".`
}

/**
 * Updates a unit's lesson from the files added since it was planned: changed
 * sections are queued to be taught again and new topics become new sections.
 *
 * @param input The module and the unit, each named by title or id.
 * @returns A sentence for the agent.
 * @throws BlitzError when the module or unit can't be identified.
 */
export async function updateUnit(blitz, input) {
  const found = await findModule(blitz, input.module)
  const { units } = await blitz.convex.query(anyApi.units.listForProject, {
    projectId: found.id,
  })
  const unit = findUnit(found, units, input.unit)
  return startUpdate(blitz, unit.id, unit.title)
}

/**
 * Resolves a unit named by id or title: an exact title first, then the only
 * title containing the words given.
 *
 * @param module The module, for the message.
 * @param units The module's units from `units.listForProject`.
 * @param name The unit's id or title.
 * @returns The unit.
 * @throws BlitzError listing the units when none, or more than one, matches.
 */
function findUnit(module, units, name) {
  const wanted = String(name ?? "").trim()
  const exact = units.filter(
    (unit) => unit.id === wanted || unit.title.toLowerCase() === wanted.toLowerCase()
  )
  const partial = units.filter((unit) =>
    unit.title.toLowerCase().includes(wanted.toLowerCase())
  )
  const unit = exact[0] ?? (wanted && partial.length === 1 ? partial[0] : null)
  if (!unit)
    throw new BlitzError(
      `No single unit in ${module.title} matches "${wanted}". Units: ${units.map((item) => `"${item.title}"`).join(", ")}.`
    )
  return unit
}

/** The changes `organise` makes. */
export const ORGANISE_ACTIONS = [
  "rename_module",
  "archive_module",
  "restore_module",
  "rename_unit",
  "move_unit",
  "move_source",
]

/**
 * Tidies the Library without losing anything: renames, archives or restores a
 * module; renames a unit or moves it along the learning path; moves a source
 * into another unit or out of every unit. Archiving keeps sources, history and
 * review schedules, and restoring undoes it.
 *
 * @param input.action One of `ORGANISE_ACTIONS`.
 * @param input.module The module's title or id.
 * @param input.unit The unit to rename or move, or the unit a source moves to.
 * @param input.title The new title, for a rename.
 * @param input.position Where a unit moves to, counting from 1.
 * @param input.source The source to move, by id or by a file name (or part of
 *   one) that only one source in the module has.
 * @returns A sentence saying what changed.
 * @throws BlitzError when something named can't be found or matches several
 *   things, or an argument is missing. Nothing changes then.
 */
export async function organise(blitz, input) {
  const found = await findModule(blitz, input.module)
  const title = String(input.title ?? "").trim()
  switch (input.action) {
    case "rename_module": {
      if (!title) throw new BlitzError("Give the module's new title.")
      await blitz.convex.mutation(anyApi.projects.renameProject, {
        projectId: found.id,
        title,
      })
      return `Renamed "${found.title}" to "${title}".`
    }
    case "archive_module":
    case "restore_module": {
      const archived = input.action === "archive_module"
      await blitz.convex.mutation(anyApi.projects.setProjectArchived, {
        projectId: found.id,
        archived,
      })
      return archived
        ? `Archived "${found.title}". Its material, answers and review schedule are kept; restore_module brings it back.`
        : `Restored "${found.title}" to the Library.`
    }
  }

  const path = await blitz.convex.query(anyApi.units.listForProject, {
    projectId: found.id,
  })
  switch (input.action) {
    case "rename_unit": {
      if (!title) throw new BlitzError("Give the unit's new title.")
      const unit = findUnit(found, path.units, input.unit)
      await blitz.convex.mutation(anyApi.units.rename, { unitId: unit.id, title })
      return `Renamed "${unit.title}" to "${title}" in ${found.title}.`
    }
    case "move_unit": {
      if (!Number.isFinite(Number(input.position)))
        throw new BlitzError("Give the position to move the unit to, counting from 1.")
      const unit = findUnit(found, path.units, input.unit)
      const from = path.units.findIndex((item) => item.id === unit.id)
      const to = Math.min(
        path.units.length - 1,
        Math.max(0, Math.round(Number(input.position)) - 1)
      )
      // Blitz moves a unit one place at a time, swapping it with its neighbour.
      const direction = to < from ? "earlier" : "later"
      for (let step = 0; step < Math.abs(to - from); step += 1)
        await blitz.convex.mutation(anyApi.units.move, { unitId: unit.id, direction })
      return to === from
        ? `"${unit.title}" is already at position ${to + 1}.`
        : `Moved "${unit.title}" to position ${to + 1} of ${path.units.length} in ${found.title}.`
    }
    case "move_source": {
      const wanted = String(input.source ?? "").trim().toLowerCase()
      if (!wanted) throw new BlitzError("Give the source's file name or id.")
      // Each source with where it sits now, so a name shared by several weeks can be told apart.
      const all = [
        ...path.units.flatMap((unit) =>
          unit.sources.map((source) => ({ source, where: unit.title }))
        ),
        ...path.unsortedSources.map((source) => ({ source, where: "unsorted" })),
        ...path.referenceSources.map((source) => ({
          source,
          where: "reference books",
          reference: true,
        })),
      ]
      const byId = all.filter((item) => item.source.id === input.source)
      const exact = all.filter((item) => item.source.filename.toLowerCase() === wanted)
      const partial = all.filter((item) => item.source.filename.toLowerCase().includes(wanted))
      // An id is unique; a file name only counts when one source has it, since
      // weeks often reuse names like "Slides.pdf" and the wrong one must not move.
      const candidates = byId.length ? byId : exact.length ? exact : partial
      if (candidates.length !== 1)
        throw new BlitzError(
          candidates.length
            ? `Several sources in ${found.title} match "${input.source}"; give one by id: ${candidates.map((item) => `"${item.source.filename}" in ${item.where} (id ${item.source.id})`).join(", ")}.`
            : `No source in ${found.title} matches "${input.source}".`
        )
      const [{ source, reference }] = candidates
      const target = input.unit ? findUnit(found, path.units, input.unit) : null
      await blitz.convex.mutation(anyApi.units.moveSource, {
        sourceId: source.id,
        ...(target ? { unitId: target.id } : {}),
      })
      // Blitz drops a moved reference book's role, so it no longer backs up every unit.
      const demoted = reference ? " It's no longer a reference book for every unit." : ""
      return target
        ? `Moved "${source.filename}" to ${target.title}.${demoted} If that unit already has a lesson, update_unit adds it.`
        : `Moved "${source.filename}" out of its unit; it's now unsorted in ${found.title}.${demoted}`
    }
    default:
      throw new BlitzError(`Unknown action "${input.action}". Use one of: ${ORGANISE_ACTIONS.join(", ")}.`)
  }
}
