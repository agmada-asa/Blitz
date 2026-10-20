/**
 * What the MCP server adds for Ocean, Allen's phone and desktop assistant,
 * when Ocean loads this repository as its Blitz plug-in (see
 * `ocean.plugin.json` at the root): a Today widget for Ocean's home screen and
 * the JSON tools behind the Blitz mini app in `ocean-app/`.
 *
 * The mini app reaches nothing directly. Every read and answer is a call to one
 * of these tools through Ocean, which runs the server with `BLITZ_OCEAN=1`.
 * The manifest marks them as Allen's own, so Ocean's agents keep the plain text
 * tools in `server.mjs` and never answer review questions on his behalf.
 */

import { anyApi } from "convex/server"
import {
  BlitzError,
  connect,
  findModule,
  modules,
  responseError,
  taught,
} from "./blitz.mjs"

/** URI of the Today widget Ocean shows on the phone's home screen and the desktop. */
export const TODAY_WIDGET = "ocean://widgets/today"

/** Resources advertised to MCP clients by `resources/list`. */
export const RESOURCE_DEFINITIONS = [
  {
    uri: TODAY_WIDGET,
    name: "Today widget",
    description:
      "Ocean widget blocks: today's XP against the goal, the streak, concepts due for review and the lesson to continue.",
    mimeType: "application/vnd.ocean.widget+json",
  },
]

/** An optional string argument's schema. */
const text = (description) => ({ type: "string", description })

/** The mini app's tools, listed only when Ocean runs the server. */
export const APP_TOOLS = [
  {
    name: "app_home",
    description:
      "For the Blitz mini app in Ocean: today's progress and every module with its Teach progress, as JSON.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "app_module",
    description:
      "For the Blitz mini app in Ocean: one module's units with their sources and Teach progress, and its practice summary, as JSON.",
    inputSchema: {
      type: "object",
      properties: { module: text("The module's id.") },
      required: ["module"],
    },
  },
  {
    name: "app_review",
    description:
      "For the Blitz mini app in Ocean: one page of the Review feed (questions without their answers, and recaps), as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("Only this module's material. Optional."),
        cursor: text("The previous page's continueCursor. Optional."),
      },
    },
  },
  {
    name: "app_answer",
    description:
      "For the Blitz mini app in Ocean: records Allen's answer to a review question; Blitz scores it and returns the feedback.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("The question's module id."),
        item: text("The question's id."),
        event: text(
          "A unique id for this answer, so a retry isn't counted twice."
        ),
        at: { type: "number", description: "When he answered, in ms." },
        answer: {
          description:
            "An option id, true or false, or a list of option ids, an order or blanks.",
        },
        confidence: text('"guess" when Allen marked the answer as a guess. Optional.'),
      },
      required: ["module", "item", "event", "at", "answer"],
    },
  },
  {
    name: "app_reveal",
    description:
      "For the Blitz mini app in Ocean: shows the answer to a single-choice question Allen is answering from memory. Records nothing.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("The question's module id."),
        item: text("The question's id."),
      },
      required: ["module", "item"],
    },
  },
  {
    name: "app_recall",
    description:
      "For the Blitz mini app in Ocean: records whether Allen knew the answer he recalled from memory, which schedules the question's next review.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("The question's module id."),
        item: text("The question's id."),
        event: text("A unique id for this answer, so a retry isn't counted twice."),
        at: { type: "number", description: "When he answered, in ms." },
        knewIt: { type: "boolean", description: "Whether he knew it." },
      },
      required: ["module", "item", "event", "at", "knewIt"],
    },
  },
  {
    name: "app_skip",
    description:
      "For the Blitz mini app in Ocean: records that Allen skipped a review question, without changing when it's due.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("The question's module id."),
        item: text("The question's id."),
        event: text("A unique id for this skip."),
        at: { type: "number", description: "When he skipped, in ms." },
      },
      required: ["module", "item", "event", "at"],
    },
  },
]

/** Names of the tools in `APP_TOOLS`. */
export const APP_TOOL_NAMES = new Set(APP_TOOLS.map((tool) => tool.name))

/** Today's summary from Convex, for this Mac's time zone and the current minute. */
function todaySummary(blitz) {
  return blitz.convex.query(anyApi.progress.today, {
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    now: Math.floor(Date.now() / 60_000) * 60_000,
  })
}

/**
 * Today and the Library in one read, for the mini app's start screen. Links
 * use the address that opens on the phone (see `connect`).
 */
async function home(blitz) {
  const [summary, all, progress] = await Promise.all([
    todaySummary(blitz),
    modules(blitz),
    blitz.convex.query(anyApi.units.libraryProgress, {}),
  ])
  return {
    links: blitz.links,
    today: {
      xp: summary.todayXp,
      goal: summary.goal,
      streak: summary.streak.current,
      longest: summary.streak.longest,
      goalMet: summary.streak.todayMet,
      answered: summary.answeredToday,
      sections: summary.sectionsToday,
      due: summary.dueConcepts,
      week: summary.week,
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
    // Recently studied modules first, then the rest newest first, as the Library orders them.
    // The sort is stable, so modules never studied keep the newest-first order.
    modules: all
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
        }
      })
      .sort((a, b) => (b.lastStudiedAt ?? 0) - (a.lastStudiedAt ?? 0)),
  }
}

/** One source as the mini app lists it. */
function sourceItem(source) {
  return {
    id: source.id,
    name: source.filename,
    status: source.status,
    unreadable: Boolean(source.unsupported),
    error: source.error ?? null,
  }
}

/** One module's units, sources and practice summary, for the module screen. */
async function moduleDetail(blitz, id) {
  const found = await findModule(blitz, id)
  const [path, practice] = await Promise.all([
    blitz.convex.query(anyApi.units.listForProject, { projectId: found.id }),
    blitz.convex.query(anyApi.practice.overview, {
      projectId: found.id,
      now: Math.floor(Date.now() / 60_000) * 60_000,
    }),
  ])
  const questions = new Map(practice.units.map((unit) => [unit.id, unit]))
  return {
    id: found.id,
    title: found.title,
    links: blitz.links,
    units: path.units.map((unit) => {
      const drill = questions.get(unit.id)
      return {
        id: unit.id,
        title: unit.title,
        taught: taught(unit.teach),
        started: Boolean(unit.teach),
        section: unit.teach?.currentSectionTitle ?? null,
        questions: drill?.questionCount ?? 0,
        answered: drill?.answeredCount ?? 0,
        correct: drill?.correctCount ?? 0,
        sources: unit.sources.map(sourceItem),
      }
    }),
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
}

/**
 * Sends a JSON request to one of the app's learning routes, the same ones the
 * web Review feed uses, and returns the parsed answer.
 * @throws BlitzError with the route's own message when it refuses.
 */
async function learning(blitz, path, init) {
  const response = await fetch(`${blitz.app}/api/learning/${path}`, init)
  if (!response.ok)
    throw new BlitzError(
      await responseError(response, "Blitz couldn't reach its Review feed.")
    )
  return response.json()
}

/** Checks that a required string argument is present. */
function required(args, name) {
  const value = args[name]
  if (typeof value !== "string" || !value.trim())
    throw new BlitzError(`\`${name}\` is required.`)
  return value.trim()
}

/** Posts one answer or skip to a learning route. */
function post(blitz, path, body) {
  return learning(blitz, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * Runs one mini app tool and returns its JSON as text.
 * @throws BlitzError for unknown tools and refused requests.
 */
export async function callAppTool(name, args) {
  const blitz = await connect()
  switch (name) {
    case "app_home":
      return JSON.stringify(await home(blitz))
    case "app_module":
      return JSON.stringify(await moduleDetail(blitz, required(args, "module")))
    case "app_review": {
      const query = new URLSearchParams({ limit: "10" })
      if (typeof args.module === "string" && args.module)
        query.set("projectId", args.module)
      if (typeof args.cursor === "string" && args.cursor)
        query.set("cursor", args.cursor)
      return JSON.stringify(await learning(blitz, `feed?${query}`))
    }
    case "app_answer":
      return JSON.stringify(
        await post(blitz, "answer", {
          projectId: required(args, "module"),
          itemId: required(args, "item"),
          clientEventId: required(args, "event"),
          occurredAt: Number(args.at),
          answer: args.answer,
          ...(args.confidence === "guess" ? { confidence: "guess" } : {}),
        })
      )
    case "app_reveal":
      return JSON.stringify(
        await post(blitz, "recall", {
          action: "reveal",
          projectId: required(args, "module"),
          itemId: required(args, "item"),
        })
      )
    case "app_recall":
      return JSON.stringify(
        await post(blitz, "recall", {
          action: "grade",
          projectId: required(args, "module"),
          itemId: required(args, "item"),
          clientEventId: required(args, "event"),
          occurredAt: Number(args.at),
          outcome: args.knewIt === true ? "correct" : "incorrect",
        })
      )
    case "app_skip":
      return JSON.stringify(
        await post(blitz, "event", {
          projectId: required(args, "module"),
          itemId: required(args, "item"),
          clientEventId: required(args, "event"),
          occurredAt: Number(args.at),
          eventType: "skip",
        })
      )
    default:
      throw new BlitzError(`No tool called ${name}.`)
  }
}

/**
 * Builds the Today widget: XP against the goal, the streak, and what to do
 * next (the lesson to continue, then review when concepts are due). Tapping
 * the widget opens the mini app; each line opens its screen.
 */
export async function todayWidget() {
  const blitz = await connect()
  const summary = await todaySummary(blitz)
  const streak = summary.streak.current
  const items = []
  if (summary.resume)
    items.push({
      text: `Continue ${summary.resume.unitTitle}`,
      detail: `${summary.resume.projectTitle} · ${summary.resume.detail}`,
      open: `module/${summary.resume.projectId}`,
    })
  if (summary.dueConcepts)
    items.push({
      text: `Review ${summary.dueConcepts} due concept${summary.dueConcepts === 1 ? "" : "s"}`,
      detail: "Questions on what hasn't stuck yet",
      open: "review",
    })
  return {
    title: "Blitz",
    open: "",
    empty: false,
    blocks: [
      {
        type: "stat",
        value: `${summary.todayXp}/${summary.goal}`,
        label: `XP today${streak ? ` · ${streak}-day streak` : ""}`,
      },
      {
        type: "progress",
        value: summary.goal ? Math.min(1, summary.todayXp / summary.goal) : 0,
      },
      ...(items.length
        ? [{ type: "list", items }]
        : [
            {
              type: "text",
              text: "Nothing due. Open a module to keep going.",
              faint: true,
            },
          ]),
    ],
  }
}

/**
 * Reads one resource for `resources/read`.
 * @throws Error when the URI is not one of `RESOURCE_DEFINITIONS`.
 */
export async function readResource(uri) {
  if (uri !== TODAY_WIDGET) throw new Error(`Unknown resource: ${uri}`)
  return {
    contents: [
      {
        uri,
        mimeType: "application/vnd.ocean.widget+json",
        text: JSON.stringify(await todayWidget()),
      },
    ],
  }
}
