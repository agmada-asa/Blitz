"use client"

/** Owns searchable project browsing, sort controls, and project creation. */

import Link from "next/link"
import { useEffect, useState } from "react"
import { AddIcon } from "@/components/ui/icon"
import { ProjectActions } from "@/components/projects/project-actions"
import { SegmentedBar } from "@/components/progress/progress-path"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  createdAt?: number
}

/** Learning progress for one module, keyed by project ID. */
type ModuleProgress = {
  unitCount: number
  taughtCount: number
  nextUnitTitle: string | null
  lastStudiedAt: number
  /** True when a module without units has sources waiting to be grouped. */
  hasUnsortedSources: boolean
  /** Share of each unit taught (0 to 1), in path order. */
  unitProgress: number[]
}

/** Props required to render the project library and create a project. */
type ProjectGridProps = {
  projects?: Project[]
  /**
   * Per-module progress, undefined while loading. Modules with no units and
   * no sources have no entry.
   */
  progress?: Record<string, ModuleProgress>
  onCreate: (title: string) => Promise<void>
}

/** Describes a module's progress in one short line. */
function progressLine(progress: ModuleProgress | undefined): string {
  if (progress?.hasUnsortedSources) return "Sources aren't in a unit yet"
  if (!progress?.unitCount) return "No material yet"
  const taught = `${progress.taughtCount} of ${progress.unitCount} unit${progress.unitCount === 1 ? "" : "s"} taught`
  return progress.nextUnitTitle ? `${taught} · Next: ${progress.nextUnitTitle}` : taught
}

/** Displays project summaries and creates a project through the supplied mutation. */
export function ProjectGrid({ projects, progress, onCreate }: ProjectGridProps) {
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<"recent" | "newest" | "name">("recent")
  const filtered = projects
    ?.filter((project) =>
      project.title
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    )
    .toSorted((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : sort === "recent"
          ? (progress?.[b._id]?.lastStudiedAt ?? 0) - (progress?.[a._id]?.lastStudiedAt ?? 0) ||
            (b.createdAt ?? 0) - (a.createdAt ?? 0)
          : (b.createdAt ?? 0) - (a.createdAt ?? 0)
    )
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
    if (creating) return
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
      await onCreate(value)
      setTitle("")
      setOpen(false)
      if (window.location.hash === "#new-project")
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search
        )
    } catch {
      setError("Could not create that project. Try again.")
    } finally {
      setCreating(false)
    }
  }

  return (
    <section>
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-medium tracking-[-0.04em]">Projects</h1>
        </div>
        <Button
          onClick={() => setOpen(true)}
          className="h-11 gap-2 rounded-full bg-brand px-4 text-brand-foreground hover:bg-brand/85"
        >
          <AddIcon aria-hidden="true" size={17} />
          <span>New project</span>
        </Button>
      </div>
      {projects && projects.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Input
            aria-label="Search projects"
            placeholder="Search projects…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-11 min-w-0 flex-1 basis-40 rounded-xl bg-card"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-11 rounded-xl">
                {sort === "recent" ? "Recently studied" : sort === "newest" ? "Newest first" : "Name A–Z"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setSort("recent")}>
                Recently studied
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSort("newest")}>
                Newest first
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSort("name")}>
                Name A–Z
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {projects === undefined ? (
        <ProjectGridLoading />
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed p-8 py-14 text-center">
          <h2 className="text-xl font-medium">No projects yet</h2>
          <Button
            onClick={() => setOpen(true)}
            className="mt-6 h-11 rounded-full px-5"
          >
            Create project
          </Button>
        </div>
      ) : filtered?.length === 0 ? (
        <div className="py-16 text-center">
          <h2 className="text-lg font-medium">No matching projects</h2>
          <Button
            variant="outline"
            className="mt-5 h-11"
            onClick={() => setSearch("")}
          >
            Clear search
          </Button>
        </div>
      ) : (
        <>
          <p role="status" className="sr-only">
            {filtered?.length} {filtered?.length === 1 ? "project" : "projects"}
          </p>
          <ul
            aria-label="Projects"
            className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(160px,200px))]"
          >
            {filtered?.map((project) => (
              <li
                key={project._id}
                className="relative h-32 min-w-0 rounded-2xl border border-border bg-card transition-colors hover:bg-muted/50"
              >
                <Link
                  href={`/projects/${project._id}`}
                  className="absolute inset-0 flex min-w-0 flex-col justify-between rounded-2xl px-3 pb-3 pt-9 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:px-4"
                >
                  <h2 className="line-clamp-2 shrink-0 text-sm font-medium tracking-tight break-words sm:text-base">
                    {project.title}
                  </h2>
                  <div className="space-y-1.5">
                    {/* One segment per unit, filled as far as it has been taught. */}
                    <SegmentedBar
                      size="sm"
                      segments={(progress?.[project._id]?.unitProgress ?? []).map(
                        (fill, index) => ({ key: String(index), fill })
                      )}
                    />
                    {progress ? (
                      // One line, so a two-line title still fits the fixed card height.
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {progressLine(progress[project._id])}
                      </p>
                    ) : (
                      <Skeleton className="h-4 w-32" />
                    )}
                  </div>
                </Link>
                <div className="absolute top-1 right-1 z-10">
                  <ProjectActions project={project} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          showCloseButton={!creating}
          aria-describedby={undefined}
          className="border-border bg-popover text-popover-foreground"
        >
          <DialogHeader>
            <DialogTitle className="font-sans text-foreground">
              New project
            </DialogTitle>
          </DialogHeader>
          <label htmlFor="project-title" className="sr-only">
            Project name
          </label>
          <Input
            id="project-title"
            disabled={creating}
            autoFocus
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create()
            }}
            placeholder="e.g. Cognitive science"
            className="h-11"
          />
          {error ? (
            <p aria-live="polite" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={creating}
              onClick={() => changeOpen(false)}
              className="h-11"
            >
              Cancel
            </Button>
            <Button
              disabled={!title.trim() || creating}
              onClick={() => void create()}
              className="h-11 bg-brand text-brand-foreground hover:bg-brand/85"
            >
              {creating ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** Shows project placeholders at the same compact size as loaded cards. */
function ProjectGridLoading() {
  return (
    <div role="status" aria-label="Loading projects">
      <span className="sr-only">Loading projects</span>
      <div
        aria-hidden="true"
        className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fill,minmax(160px,200px))]"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton
            key={index}
            className="h-28 rounded-2xl bg-card"
          />
        ))}
      </div>
    </div>
  )
}
