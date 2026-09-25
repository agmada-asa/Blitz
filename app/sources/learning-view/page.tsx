/** Opens one project learning citation in a standalone source reader. */
import { SourceReader } from "@/components/chat/source-pane"
import type { Id } from "@/convex/_generated/dataModel"

/** Resolves a learning citation from its project, source, and optional locator. */
export default async function LearningSourcePage({
  searchParams,
}: {
  searchParams: Promise<{
    projectId?: string
    sourceId?: string
    locator?: string
  }>
}) {
  const { projectId, sourceId, locator } = await searchParams
  if (!projectId || !sourceId)
    return <p className="p-6">Open a citation from a learning path to read its source.</p>
  return (
    <main className="flex h-[100dvh] min-h-0 flex-col">
      <SourceReader
        selection={{
          kind: "learning",
          projectId: projectId as Id<"projects">,
          sourceId: sourceId as Id<"sources">,
          filename: "Source",
          locator,
        }}
      />
    </main>
  )
}
