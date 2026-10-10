/**
 * Defines the HTTP contracts the Android app uses for the Teach, Practice, and
 * Home loop: today's progress, the module library, a module's learning path,
 * a unit's Teach session, drills, and session summaries.
 *
 * Routes under `app/api/mobile/` produce these shapes from Convex; the app in
 * `mobile/` imports them as types only, so both sides change together. Every
 * shape is plain JSON with string IDs, because the app does not depend on
 * Convex. Answers still go through the shared routes: `/api/learning/answer`
 * for drill and feed questions, `/api/teach/answer` for lesson quizzes, and
 * `/api/chat` for Teach turns.
 */

import type { QuestionFeedCard } from "./client-contracts"

/** How well a concept is known, from its answer history. */
export type MobileConceptStrength = "new" | "weak" | "learning" | "strong"

/** Where a unit's Teach session stands. */
export type MobileTeachProgress = {
  /** Sections in the outline; 0 before the first reply arrives. */
  sectionCount: number
  /** Zero-based section being taught; equal to `sectionCount` once complete. */
  sectionIndex: number
  completed: boolean
  /** Sections actually taught; a jump can leave earlier ones untaught. */
  taughtSectionIds: string[]
  /** Section ids in outline order. */
  sectionIds: string[]
  currentSectionTitle: string | null
}

/** The unit to resume from Home, with enough to draw its section bar. */
export type MobileResume = {
  projectId: string
  projectTitle: string
  unitId: string
  unitTitle: string
  /** For example "Section 2 of 6: Loop invariants". */
  detail: string
  sectionCount: number
  sectionIndex: number
  taughtSectionIds: string[]
  sectionIds: string[]
}

/** GET /api/mobile/home: the Today page at the top of Home. */
export type MobileHomeResponse = {
  /** Today's local day key, `YYYY-MM-DD`. */
  today: string
  todayXp: number
  goal: number
  streak: { current: number; todayMet: boolean; longest: number }
  /** XP for the last seven local days, oldest first, ending today. */
  week: Array<{ day: string; xp: number }>
  resume: MobileResume | null
  dueConcepts: number
}

/** One module in the library. */
export type MobileModuleSummary = {
  id: string
  title: string
  unitCount: number
  taughtCount: number
  nextUnitTitle: string | null
  lastStudiedAt: number
  /** Share of each unit taught (0 to 1), in path order. */
  unitProgress: number[]
  /** True when the module has sources that are not in a unit yet. */
  hasUnsortedSources: boolean
}

/** GET /api/mobile/modules: every module, most recently studied first. */
export type MobileLibraryResponse = { modules: MobileModuleSummary[] }

/** One unit on a module's learning path. */
export type MobileUnit = {
  id: string
  title: string
  sourceCount: number
  /** False until at least one source has readable text; Teach waits for it. */
  hasText: boolean
  teach: MobileTeachProgress | null
  /** Practice questions in the unit's bank. */
  questionCount: number
  /** Strength of each concept in the unit's bank. */
  concepts: Array<{ id: string; title: string; strength: MobileConceptStrength }>
}

/** One exam paper, listed for reference on the phone. */
export type MobilePaper = {
  id: string
  title: string
  kind: "past" | "mock"
  status: string
  questionCount: number
  totalMarks: number | null
  durationMinutes: number | null
  bestPercentage: number | null
}

/** GET /api/mobile/modules/[projectId]: a module's learning path and practice. */
export type MobileModuleResponse = {
  id: string
  title: string
  units: MobileUnit[]
  /** Sources imported before units existed; grouping them happens on desktop. */
  unsortedSourceCount: number
  practice: {
    /** Practice questions across every unit. */
    questionCount: number
    /** Questions whose latest answer was wrong. */
    missedCount: number
    /** Questions never answered. */
    unansweredCount: number
    weakConcepts: Array<{ id: string; title: string; unitId: string; unitTitle: string }>
  }
  papers: MobilePaper[]
}

/** A message in a unit's Teach session. */
export type MobileTeachMessage = {
  id: string
  role: "user" | "assistant"
  /** Markdown with ```outline, ```section, and interactive block fences. */
  content: string
  status: "running" | "completed" | "failed"
  createdAt: number
}

/** A recorded answer to a lesson quiz. */
export type MobileAnsweredQuiz = { selectedOptionIds: string[]; correct: boolean }

/** GET /api/mobile/teach?unitId=: a unit's Teach session. */
export type MobileTeachResponse = {
  unit: {
    id: string
    title: string
    projectId: string
    projectTitle: string
    /** False until a source has readable text; teaching waits for it. */
    hasText: boolean
    sourceCount: number
    nextUnit: { id: string; title: string } | null
  }
  /** The session chat, or null before it is opened with POST. */
  chatId: string | null
  status: "idle" | "running" | "failed"
  lastError: string | null
  /** The saved outline; until the first reply finishes, parse it from the messages. */
  outline: { title: string; sections: Array<{ id: string; title: string }> } | null
  progress: MobileTeachProgress | null
  messages: MobileTeachMessage[]
  /** Recorded quiz answers by message id, then quiz id. */
  answered: Record<string, Record<string, MobileAnsweredQuiz>>
}

/** POST /api/mobile/teach: opens (or, with `restart`, restarts) a unit's session. */
export type MobileTeachStartRequest = { unitId: string; restart?: boolean }

/** Response to POST /api/mobile/teach. */
export type MobileTeachStartResponse = { chatId: string }

/** One drill question: a feed question card plus its unit. */
export type MobileDrillQuestion = {
  card: QuestionFeedCard
  unitId: string
  /** The question's previous outcome, if it was answered before. */
  lastOutcome: "correct" | "incorrect" | null
}

/** GET /api/mobile/drill?projectId=&unitId=: an adaptive drill, missed and weak first. */
export type MobileDrillResponse = { questions: MobileDrillQuestion[] }

/** GET /api/mobile/summary: what a session added up to, as on desktop. */
export type MobileSessionSummary = {
  answered: number
  correct: number
  xp: number
  sections: number
  unitsCompleted: number
  concepts: Array<{
    conceptId: string
    title: string
    answered: number
    correct: number
    strength: MobileConceptStrength
  }>
  today: { xp: number; goal: number; streak: { current: number; todayMet: boolean; longest: number } }
}
