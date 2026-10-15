/** Renders the Review feed: questions and recaps weighted towards weak concepts. */

import { Feed } from "@/components/feed/feed"

/** Renders the Review feed, optionally narrowed to one project or topic. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; topicId?: string }>
}) {
  const filters = await searchParams
  return (
    <Feed
      initialFilter={{
        projectId: filters.projectId ?? "",
        topicId: filters.topicId ?? "",
      }}
    />
  )
}
