"use client"

/**
 * The start page: today's progress and ways to continue, above the project
 * library. Connects the library to its Convex query and create mutation.
 */

import { useMutation, useQuery } from "convex/react"

import { ProjectGrid } from "@/components/projects/project-grid"
import { TodayPanel } from "@/components/progress/today-panel"
import { useMinuteClock } from "@/hooks/use-minute-clock"
import { api } from "@/convex/_generated/api"

/** Renders the Today panel and the live project library. */
export default function Page() {
  const now = useMinuteClock()
  const projects = useQuery(api.projects.listProjects)
  const progress = useQuery(api.units.libraryProgress, { now })
  const createProject = useMutation(api.projects.createProject)

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10 pb-28 sm:px-8 sm:py-16">
      <TodayPanel />
      <ProjectGrid
        projects={projects}
        progress={progress}
        onCreate={async (title) => {
          await createProject({ title })
        }}
      />
    </main>
  )
}
