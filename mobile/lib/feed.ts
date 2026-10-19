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
  // A card repeated in a later round keeps its id but has a new key.
  const knownKeys = new Set(cards.map((card) => card.key ?? card.id))
  for (const card of next.cards) {
    const key = card.key ?? card.id
    if (!knownKeys.has(key)) {
      knownKeys.add(key)
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
