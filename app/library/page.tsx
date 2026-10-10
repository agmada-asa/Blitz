"use client"

/** Connects the project library route to its Convex query and create mutation. */

import { useMutation, useQuery } from "convex/react"

import { ProjectGrid } from "@/components/projects/project-grid"
import { api } from "@/convex/_generated/api"

/** Renders the live project library and forwards project creation to Convex. */
export default function Page() {
  const projects = useQuery(api.projects.listProjects)
  const progress = useQuery(api.units.libraryProgress, {})
  const createProject = useMutation(api.projects.createProject)

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-10 pb-28 sm:px-8 sm:py-16">
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
