/** Renders the live mixed learning feed at the root route. */

import { Feed } from "@/components/feed/feed"

/** Renders the live mixed learning feed. */
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
