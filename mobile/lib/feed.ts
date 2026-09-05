/** Owns pure feed filtering and page merge rules shared by the native shell and tests. */

import type { MobileFeedPayload, MobileLearningCard } from "./contracts"

/** Returns cards matching the selected project and topic, including an empty result when offline data has no match. */
export function filterCards(
  payload: MobileFeedPayload | undefined,
  projectId: string | undefined,
  topicId: string | undefined
): MobileLearningCard[] {
  return (payload?.cards ?? []).filter(
    (card) =>
      (!projectId || card.projectId === projectId) &&
      (!topicId || card.topicId === topicId)
  )
}

/** Appends cards from the same feed query while preserving metadata and order. */
export function appendFeedPage(
  current: MobileFeedPayload,
  next: MobileFeedPayload
): MobileFeedPayload {
  const cards = [...current.cards]
  const knownIds = new Set(cards.map((card) => card.id))
  for (const card of next.cards) {
    if (!knownIds.has(card.id)) {
      knownIds.add(card.id)
      cards.push(card)
    }
  }
  const projects = new Map(
    [...current.projects, ...next.projects].map((project) => [
      project.id,
      project,
    ])
  )
  const topics = new Map(
    [...current.topics, ...next.topics].map((topic) => [topic.id, topic])
  )
  return {
    ...next,
    cards,
    projects: [...projects.values()],
    topics: [...topics.values()],
  }
}

/** Replaces cards for a new filter query while retaining known filter choices. */
export function mergeFeedMetadata(
  current: MobileFeedPayload | undefined,
  next: MobileFeedPayload
): MobileFeedPayload {
  const projects = new Map(
    [...(current?.projects ?? []), ...next.projects].map((project) => [
      project.id,
      project,
    ])
  )
  const topics = new Map(
    [...(current?.topics ?? []), ...next.topics].map((topic) => [
      topic.id,
      topic,
    ])
  )
  return {
    ...next,
    projects: [...projects.values()],
    topics: [...topics.values()],
  }
}
