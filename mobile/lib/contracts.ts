/**
 * Adapts the shared learning HTTP contract for the native UI and persistence
 * layer. The source contract owns all field names so Android cannot drift from
 * the browser routes.
 */

import type {
  AnswerResponse,
  EventRequest,
  FeedCard,
  FeedProject,
  FeedResponse,
  FeedTopic,
  LearningAnswer,
} from "../../lib/learning/client-contracts"

/** A card format accepted by the native renderer. */
export type MobileCardType = FeedCard["type"]

/** A selectable option without server-owned correctness metadata. */
export type MobileOption = NonNullable<Extract<FeedCard, { type: "single-choice" }>["options"]>[number]

/** A source reference reduced to the label available in the feed contract. */
export type MobileSourceReference = { readonly label: string }

/** One shared feed card safe to cache on the device. */
export type MobileLearningCard = FeedCard

/** One project or topic filter choice rendered by the native filter panel. */
export type MobileFilterChoice = MobileProjectChoice | MobileTopicChoice

/** Project filter choice with the shared server field names. */
export type MobileProjectChoice = FeedProject

/** Topic filter choice with its owning project identity. */
export type MobileTopicChoice = FeedTopic

/** The exact feed response returned by GET /api/learning/feed. */
export type MobileFeedPayload = FeedResponse

/** The answer values accepted by POST /api/learning/answer. */
export type MobileAnswer = LearningAnswer

/** A local retry event carrying the IDs required by the shared contract. */
export type MobilePendingEvent =
  | {
      readonly eventId: string
      readonly projectId: string
      readonly cardId: string
      readonly type: "answer"
      readonly answer: MobileAnswer
      readonly occurredAt: number
    }
  | {
      readonly eventId: string
      readonly projectId: string
      readonly cardId: string
      readonly type: "skip" | "exposure"
      readonly occurredAt: number
    }

/** Server-owned answer feedback, including the revealed explanation. */
export type MobileAnswerResult = AnswerResponse

/** Card feedback shown after a server response or while a request is queued. */
export type MobileAnswerFeedback =
  | AnswerResponse
  | { readonly status: "pending"; readonly isCorrect?: false }

/** Keeps the shared event payload type reachable for transport adapters. */
export type MobileEventRequest = EventRequest

/** Keeps the shared feed card type reachable for transport adapters. */
export type MobileFeedCard = FeedCard

/** Avoids an unused type import in builds that inspect generated declarations. */
export type MobileContractResponse = MobileFeedPayload
