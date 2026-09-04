"use client"

/** Renders the compact dark project library and owns project creation. */

import Link from "next/link"
import { useEffect, useState } from "react"
import { AddIcon, ArrowUpRightIcon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

/** Project summary returned by the library query. */
type Project = {
  _id: string
  title: string
}

/** Props required to render the project library and create a project. */
type ProjectGridProps = {
  projects?: Project[]
  onCreate?: (title: string) => Promise<void>
}

/** Displays project summaries and creates a project through the supplied mutation. */
export function ProjectGrid({ projects, onCreate }: ProjectGridProps) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    /** Opens the dialog when navigation includes the new-project hash. */
    const openFromHash = () => {
      if (window.location.hash === "#new-project") setOpen(true)
    }

    openFromHash()
    window.addEventListener("hashchange", openFromHash)
    return () => window.removeEventListener("hashchange", openFromHash)
  }, [])

  /** Closes the dialog and removes its navigation hash when necessary. */
  const changeOpen = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) setError("")
    if (!nextOpen && window.location.hash === "#new-project") {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      )
    }
  }

  /** Validates and submits the new project title. */
  const create = async () => {
    const value = title.trim()
    if (!value || creating) return
    setCreating(true)
    setError("")
    try {
      if (onCreate) await onCreate(value)
      setTitle("")
      changeOpen(false)
    } catch {
      setError("Could not create that project. Try again.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="-mx-5 -my-10 min-h-svh bg-[#080808] px-5 py-8 text-white sm:-mx-8 sm:-my-16 sm:px-8 sm:py-12">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-8 flex items-center justify-between gap-4">
          <h1 className="font-sans text-3xl font-medium tracking-[-0.04em]">
            Projects
          </h1>
          <Button
            size="sm"
            onClick={() => setOpen(true)}
            className="h-10 gap-2 rounded-[20px] bg-[#ff8065] px-4 text-sm font-medium text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
          >
            <AddIcon aria-hidden="true" size={17} />
            New project
          </Button>
        </div>

        {projects === undefined ? (
          <ProjectGridLoading />
        ) : projects.length === 0 ? (
          <div className="rounded-[20px] border border-white/10 bg-white/[0.035] px-5 py-10">
            <h2 className="font-sans text-lg font-medium tracking-[-0.02em]">
              No projects yet
            </h2>
            <Button
              onClick={() => setOpen(true)}
              className="mt-5 h-10 rounded-[20px] bg-white px-4 text-sm font-medium text-[#111] hover:bg-white/85"
            >
              Create project
            </Button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-[20px] border border-white/10 bg-[#151515]">
            <ul aria-label="Projects">
              {projects.map((project) => (
                <li
                  key={project._id}
                  className="border-b border-white/10 last:border-0"
                >
                  <Link
                    href={`/projects/${project._id}`}
                    className="group flex min-h-20 items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-white/[0.045] focus-visible:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-[#ff8065] focus-visible:outline-none sm:px-6"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base font-medium tracking-[-0.015em] text-white">
                        {project.title}
                      </span>
                    </span>
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="size-5 shrink-0 text-white/35 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="border-white/10 bg-[#151515] text-white"
        >
          <DialogHeader>
            <DialogTitle className="font-sans text-white">
              New project
            </DialogTitle>
          </DialogHeader>
          <label htmlFor="project-title" className="sr-only">
            Project name
          </label>
          <Input
            id="project-title"
            autoFocus
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create()
            }}
            placeholder="e.g. Cognitive science"
            className="border-white/10 bg-white/[0.045] text-white placeholder:text-white/30 focus-visible:border-[#ff8065] focus-visible:ring-[#ff8065]/30"
          />
          {error ? (
            <p aria-live="polite" className="text-sm text-red-200">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => changeOpen(false)}
              className="border-white/15 bg-transparent text-white/75 hover:bg-white/[0.07] hover:text-white"
            >
              Cancel
            </Button>
            <Button
              disabled={!title.trim() || creating}
              onClick={() => void create()}
              className="bg-[#ff8065] text-[#1b0d0a] hover:bg-[#ff9b86] focus-visible:ring-[#ff8065]/50"
            >
              {creating ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** Shows compact project rows while the library query resolves. */
function ProjectGridLoading() {
  return (
    <div role="status" aria-label="Loading projects">
      <span className="sr-only">Loading projects</span>
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-[20px] border border-white/10 bg-[#151515]"
      >
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-20 items-center justify-between border-b border-white/10 px-5 py-4 last:border-0 sm:px-6"
          >
            <div className="space-y-2">
              <Skeleton className="h-5 w-44 bg-white/10" />
              <Skeleton className="h-4 w-24 bg-white/[0.07]" />
            </div>
            <Skeleton className="size-5 rounded-full bg-white/[0.07]" />
          </div>
        ))}
      </div>
    </div>
  )
}
