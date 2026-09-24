/** Presents the proposed project area as isolated, hardcoded screens for review. */

import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  HomeMockup,
  homeScenes,
} from "@/components/preview/project-overhaul/home"
import {
  LearnMockup,
  learnScenes,
} from "@/components/preview/project-overhaul/learn"
import {
  PracticeMockup,
  practiceScenes,
} from "@/components/preview/project-overhaul/practice"
import {
  SourcesMockup,
  sourceScenes,
} from "@/components/preview/project-overhaul/sources"
import {
  ListenMockup,
  listenScenes,
} from "@/components/preview/project-overhaul/listen"
import {
  ChatMockup,
  chatScenes,
} from "@/components/preview/project-overhaul/chat"

/** The six destinations in the proposed project navigation. */
const groups: ReadonlyArray<{
  label: string
  scenes: ReadonlyArray<{ id: string; label: string }>
}> = [
  { label: "Project", scenes: homeScenes },
  { label: "Learn", scenes: learnScenes },
  { label: "Practice", scenes: practiceScenes },
  { label: "Sources", scenes: sourceScenes },
  { label: "Listen", scenes: listenScenes },
  { label: "Chat", scenes: chatScenes },
]

/** Builds a local preview link without connecting to a real project. */
function sceneHref(id: string) {
  return `/preview/project-overhaul?screen=${encodeURIComponent(id)}`
}

/** Renders the requested static screen from its owning feature group. */
function ScreenContent({ group, scene }: { group: string; scene: string }) {
  switch (group) {
    case "Project":
      return <HomeMockup scene={scene} />
    case "Learn":
      return <LearnMockup scene={scene} />
    case "Practice":
      return <PracticeMockup scene={scene} />
    case "Sources":
      return <SourcesMockup scene={scene} />
    case "Listen":
      return <ListenMockup scene={scene} />
    default:
      return <ChatMockup scene={scene} />
  }
}

/** Shows every proposed project screen through one review-only route. */
export default async function ProjectOverhaulPreview({
  searchParams,
}: {
  searchParams: Promise<{ screen?: string }>
}) {
  const requested = (await searchParams).screen ?? "overview"
  const selection = groups
    .flatMap((group) =>
      group.scenes.map((scene) => ({ ...scene, group: group.label }))
    )
    .find((scene) => scene.id === requested)
  const current = selection ?? {
    id: "overview",
    label: "Overview",
    group: "Project",
  }

  return (
    <main className="min-h-svh bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <h1 className="text-base font-semibold tracking-tight">
            Project mockups
          </h1>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/">Back to Blitz</Link>
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1600px] md:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="border-b border-border p-3 md:sticky md:top-0 md:h-svh md:overflow-y-auto md:border-r md:border-b-0 md:p-5">
          <details className="md:hidden">
            <summary className="cursor-pointer rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              {current.label}
            </summary>
            <nav
              aria-label="Preview screens"
              className="mt-3 max-h-[48svh] space-y-4 overflow-y-auto px-1 pb-2"
            >
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground uppercase">
                    {group.label}
                  </p>
                  <div className="space-y-0.5">
                    {group.scenes.map((scene) => (
                      <Link
                        key={scene.id}
                        href={sceneHref(scene.id)}
                        prefetch={false}
                        aria-current={
                          scene.id === current.id ? "page" : undefined
                        }
                        className={`block rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${scene.id === current.id ? "bg-brand/10 font-medium text-brand" : "text-foreground hover:bg-muted"}`}
                      >
                        {scene.label}
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </nav>
          </details>
          <nav
            aria-label="Preview screens"
            className="hidden space-y-2 md:block"
          >
            {groups.map((group) => (
              <details key={group.label} open={group.label === current.group}>
                <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                  {group.label}
                </summary>
                <div className="mt-1 space-y-0.5 pl-2">
                  {group.scenes.map((scene) => (
                    <Link
                      key={scene.id}
                      href={sceneHref(scene.id)}
                      prefetch={false}
                      aria-current={
                        scene.id === current.id ? "page" : undefined
                      }
                      className={`block rounded-lg px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${scene.id === current.id ? "bg-brand/10 font-medium text-brand" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                    >
                      {scene.label}
                    </Link>
                  ))}
                </div>
              </details>
            ))}
          </nav>
        </aside>

        <section
          aria-label={`${current.label} mockup`}
          className="min-w-0 px-4 py-5 sm:px-6 lg:px-10"
        >
          <ScreenContent group={current.group} scene={current.id} />
        </section>
      </div>
    </main>
  )
}
