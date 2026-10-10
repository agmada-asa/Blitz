/**
 * Builds the Android app's Teach, Practice, and Home payloads
 * (`lib/learning/mobile-contracts.ts`) from Convex queries. The routes under
 * `app/api/mobile/` stay thin: they read request parameters, call one of these
 * functions, and turn `MobileRequestError` into a 4xx response.
 *
 * Nothing here scores answers or changes progress; it only reads and reshapes,
 * apart from `startTeachSession`, which opens a unit's session exactly as the
 * desktop Teach screen does.
 */

import type { ConvexHttpClient } from "convex/browser"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type {
  MobileDrillResponse,
  MobileHomeResponse,
  MobileLibraryResponse,
  MobileModuleResponse,
  MobileSessionSummary,
  MobileTeachProgress,
  MobileTeachResponse,
  MobileTeachStartResponse,
} from "@/lib/learning/mobile-contracts"
import { serverConvexClient } from "@/lib/server/convex"

/** A request problem whose message is safe to show in the app. */
export class MobileRequestError extends Error {
  /** Creates an error with the HTTP status the route should return. */
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message)
    this.name = "MobileRequestError"
  }
}

/**
 * Returns the server Convex client. When Convex is not configured it throws,
 * and `mobileErrorResponse` turns that into a generic 503.
 */
function client(): ConvexHttpClient {
  return serverConvexClient()
}

/**
 * Reads a Convex document id from a query parameter or body field.
 * @throws MobileRequestError when it is missing or malformed.
 */
export function readId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new MobileRequestError(`${label} is missing or invalid`)
  return value
}

/**
 * Reads the device's `Date#getTimezoneOffset()` so days follow its midnight.
 * Defaults to UTC when absent.
 */
export function readTimezoneOffset(value: string | null): number {
  if (value === null || value === "") return 0
  const offset = Number(value)
  if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60)
    throw new MobileRequestError("Time zone is invalid")
  return offset
}

/** Narrows a unit's Teach summary to the mobile shape. */
function teachProgress(
  teach: {
    sectionCount: number
    sectionIndex: number
    completed: boolean
    taughtSectionIds: string[]
    sectionIds: string[]
    currentSectionTitle: string | null
  } | null
): MobileTeachProgress | null {
  if (!teach) return null
  return {
    sectionCount: teach.sectionCount,
    sectionIndex: Math.max(0, teach.sectionIndex),
    completed: teach.completed,
    taughtSectionIds: teach.taughtSectionIds,
    sectionIds: teach.sectionIds,
    currentSectionTitle: teach.currentSectionTitle,
  }
}

/**
 * Today's XP, streak, week, and the unit to resume, for the top of Home.
 * @param tzOffsetMinutes The device's time zone offset.
 */
export async function homeSummary(tzOffsetMinutes: number): Promise<MobileHomeResponse> {
  const today = await client().query(api.progress.today, { tzOffsetMinutes, now: Date.now() })
  return {
    today: today.today,
    todayXp: today.todayXp,
    goal: today.goal,
    streak: today.streak,
    week: today.week,
    resume: today.resume,
    dueConcepts: today.dueConcepts,
  }
}

/** Every module with its progress, most recently studied first, then newest. */
export async function libraryModules(): Promise<MobileLibraryResponse> {
  const convex = client()
  const [projects, progress] = await Promise.all([
    convex.query(api.projects.listProjects, {}),
    convex.query(api.units.libraryProgress, {}),
  ])
  const modules = projects.map((project) => {
    const entry = progress[project._id]
    return {
      id: project._id,
      title: project.title,
      unitCount: entry?.unitCount ?? 0,
      taughtCount: entry?.taughtCount ?? 0,
      nextUnitTitle: entry?.nextUnitTitle ?? null,
      lastStudiedAt: entry?.lastStudiedAt ?? 0,
      unitProgress: entry?.unitProgress ?? [],
      hasUnsortedSources: entry?.hasUnsortedSources ?? false,
      createdAt: project.createdAt ?? 0,
    }
  })
  modules.sort((a, b) => b.lastStudiedAt - a.lastStudiedAt || b.createdAt - a.createdAt)
  return { modules: modules.map(({ createdAt: _createdAt, ...module }) => module) }
}

/**
 * A module's learning path, practice summary, and exam papers.
 * @throws MobileRequestError (404) when the module does not exist.
 */
export async function moduleDetail(projectId: string): Promise<MobileModuleResponse> {
  const convex = client()
  const id = projectId as Id<"projects">
  const project = await convex.query(api.projects.getProject, { projectId: id })
  if (!project) throw new MobileRequestError("This module no longer exists", 404)
  const [path, practice, papers] = await Promise.all([
    convex.query(api.units.listForProject, { projectId: id }),
    convex.query(api.practice.overview, { projectId: id, now: Date.now() }),
    convex.query(api.exam.listPapers, { projectId: id }),
  ])
  const bankByUnit = new Map(practice.units.map((unit) => [String(unit.id), unit]))
  return {
    id: project._id,
    title: project.title,
    units: path.units.map((unit) => {
      const bank = bankByUnit.get(String(unit.id))
      return {
        id: unit.id,
        title: unit.title,
        sourceCount: unit.sources.length,
        hasText: unit.sources.some((source) => source.hasText),
        teach: teachProgress(unit.teach),
        questionCount: bank?.questionCount ?? 0,
        concepts: (bank?.concepts ?? []).map((concept) => ({
          id: concept.id,
          title: concept.title,
          strength: concept.strength,
        })),
      }
    }),
    unsortedSourceCount: path.unsortedSources.length,
    practice: {
      questionCount: practice.units.reduce((sum, unit) => sum + unit.questionCount, 0),
      missedCount: practice.missedCount,
      unansweredCount: practice.unansweredCount,
      weakConcepts: practice.weakConcepts.map((concept) => ({
        id: concept.id,
        title: concept.title,
        unitId: concept.unitId,
        unitTitle: concept.unitTitle,
      })),
    },
    papers: papers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      kind: paper.kind,
      status: paper.status,
      questionCount: paper.questionCount,
      totalMarks: paper.totalMarks,
      durationMinutes: paper.durationMinutes,
      bestPercentage: paper.bestPercentage,
    })),
  }
}

/**
 * A unit's Teach session: the unit, its outline and progress, every message,
 * and recorded quiz answers. Before the session is opened, `chatId` is null.
 * @throws MobileRequestError (404) when the unit does not exist.
 */
export async function teachSession(unitId: string): Promise<MobileTeachResponse> {
  const convex = client()
  const unit = await convex.query(api.units.get, { unitId: unitId as Id<"units"> })
  if (!unit) throw new MobileRequestError("This unit no longer exists", 404)
  const chatId = unit.teach?.chatId ?? null
  const [chat, answered] = chatId
    ? await Promise.all([
        convex.query(api.workspaceChats.get, { chatId }),
        convex.query(api.teach.answeredQuizzes, { chatId }),
      ])
    : [null, {}]
  return {
    unit: {
      id: unit.id,
      title: unit.title,
      projectId: unit.projectId,
      projectTitle: unit.projectTitle,
      hasText: unit.sources.some((source) => source.hasText),
      sourceCount: unit.sources.length,
      nextUnit: unit.nextUnit,
    },
    chatId,
    status: chat?.status ?? "idle",
    lastError: chat?.lastError ?? null,
    outline: unit.outline,
    progress: teachProgress(unit.teach),
    messages: (chat?.messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      createdAt: message.createdAt,
    })),
    answered,
  }
}

/**
 * Opens a unit's Teach session, creating it on first visit. With `restart`,
 * archives the current session first so the next turn starts a new outline;
 * answered questions keep their history.
 */
export async function startTeachSession(
  unitId: string,
  restart: boolean
): Promise<MobileTeachStartResponse> {
  const convex = client()
  const id = unitId as Id<"units">
  if (restart) {
    try {
      await convex.mutation(api.units.restartTeach, { unitId: id })
    } catch (error) {
      if (error instanceof Error && error.message.includes("Wait for the reply to finish"))
        throw new MobileRequestError("Wait for the reply to finish, then start over", 409)
      throw error
    }
  }
  const { chatId } = await convex.mutation(api.units.startTeach, { unitId: id })
  return { chatId }
}

/**
 * An adaptive drill as question cards without answer keys.
 * @param limit Questions to ask, 1 to 20.
 */
export async function drillQuestions(
  projectId: string,
  unitId: string | undefined,
  limit: number
): Promise<MobileDrillResponse> {
  const questions = await client().query(api.practice.drillCards, {
    projectId: projectId as Id<"projects">,
    ...(unitId ? { unitId: unitId as Id<"units"> } : {}),
    limit,
    now: Date.now(),
  })
  return {
    questions: questions.flatMap(({ card, unitId: questionUnitId, lastOutcome }) =>
      card.type === "explain" ? [] : [{ card, unitId: questionUnitId, lastOutcome }]
    ),
  }
}

/**
 * What a session added up to since `since`, limited to a module and
 * optionally one unit, as the desktop session summary shows it.
 */
export async function sessionSummary(input: {
  projectId: string
  unitId?: string
  since: number
  tzOffsetMinutes: number
}): Promise<MobileSessionSummary> {
  const summary = await client().query(api.progress.sessionSummary, {
    projectId: input.projectId as Id<"projects">,
    ...(input.unitId ? { unitId: input.unitId as Id<"units"> } : {}),
    since: input.since,
    tzOffsetMinutes: input.tzOffsetMinutes,
    now: Date.now(),
  })
  return {
    answered: summary.answered,
    correct: summary.correct,
    xp: summary.xp,
    sections: summary.sections,
    unitsCompleted: summary.unitsCompleted,
    concepts: summary.concepts.map((concept) => ({
      conceptId: concept.conceptId,
      title: concept.title,
      answered: concept.answered,
      correct: concept.correct,
      strength: concept.strength,
    })),
    today: summary.today,
  }
}

/**
 * Turns a thrown error into a JSON response: request problems keep their
 * message and status; anything else becomes a generic 503 so database
 * details never reach the app.
 * @param error The caught error.
 * @param what What was being loaded, for the generic message and the log.
 */
export function mobileErrorResponse(error: unknown, what: string): Response {
  if (error instanceof MobileRequestError)
    return Response.json({ error: error.message }, { status: error.status })
  // Convex rejects malformed ids with a validator error; treat them as not found.
  if (error instanceof Error && /ArgumentValidationError|Invalid argument|not a valid ID/i.test(error.message))
    return Response.json({ error: `This ${what} no longer exists` }, { status: 404 })
  console.error(`Mobile ${what} could not be loaded`, {
    message: error instanceof Error ? error.message.slice(0, 200) : "Unknown error",
  })
  return Response.json({ error: `The ${what} could not be loaded. Try again.` }, { status: 503 })
}
