/** Defines the shared HTTP learning contracts consumed by browser and native clients. */

/** Supported feed item formats exposed before an answer is submitted. */
export type FeedCardType =
  "explain" | "single-choice" | "multiple-answer" | "true-false"

/** One visible choice in a question card; correctness is withheld in feed data. */
export type FeedOption = {
  id: string
  text: string
}

/** Shared identity and attribution fields on every feed card. */
type FeedCardBase = {
  id: string
  /**
   * Unique within one feed session. A card repeated in a later round has the
   * same `id` but a new `key`, so clients render it as a new card.
   */
  key?: string
  projectId: string
  conceptId: string
  topicId?: string
  title: string
  sourceLabel: string
  sourceIds: string[]
}

/** An explanation card whose body is visible before any answer. */
export type ExplainFeedCard = FeedCardBase & {
  type: "explain"
  body: string
  question?: never
  options?: never
}

/** A choice or true-false card whose explanation is revealed after answering. */
export type QuestionFeedCard = FeedCardBase & {
  type: Exclude<FeedCardType, "explain">
  body?: never
  question: string
  options?: FeedOption[]
}

/** A feed card union that keeps explain and question fields distinct. */
export type FeedCard = ExplainFeedCard | QuestionFeedCard

/** Project filter option returned alongside feed cards. */
export type FeedProject = { id: string; title: string }

/** Topic filter option returned alongside feed cards. */
export type FeedTopic = { id: string; projectId: string; title: string }

/** One page of the home feed: questions and concept recaps, shared by browser and native clients. */
export type FeedResponse = {
  cards: FeedCard[]
  projects: FeedProject[]
  topics: FeedTopic[]
  isDone?: boolean
  continueCursor?: string | null
}

/** Answer values accepted by the server evaluator. */
export type LearningAnswer = string | boolean | string[]

/** Request payload for one scored learning answer. */
export type AnswerRequest = {
  projectId: string
  itemId: string
  clientEventId: string
  occurredAt: number
  answer: LearningAnswer
}

/** Server-owned fields revealed only after an answer is evaluated. */
export type AnswerFeedback = {
  body: string
  correctOptionId?: string
  correctOptionIds?: string[]
  correctAnswer?: boolean
}

/** Response from the server-scored answer mutation. */
export type AnswerResponse = {
  status: "correct" | "incorrect" | "invalid"
  isCorrect: boolean
  eventId: string | null
  alreadyRecorded: boolean
  feedback?: AnswerFeedback
  reason?: string
}

/** Passive event types that never change a concept review summary. */
export type PassiveEventType = "skip" | "exposure"

/** Request payload for one passive feed event. */
export type EventRequest = {
  projectId: string
  itemId: string
  clientEventId: string
  occurredAt: number
  eventType: PassiveEventType
}

/** Response from the passive event mutation. */
export type EventResponse = {
  eventId: string
  alreadyRecorded: boolean
  eventType: PassiveEventType
}
