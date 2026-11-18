"use client"

/** Owns searchable project browsing, sort controls, and project creation. */

import Link from "next/link"
import { useEffect, useState } from "react"
import { AddIcon, SearchIcon, SortIcon } from "@/components/ui/icon"
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
import { isArchived } from "@/lib/projects"

/** Project summary returned by the library query. */
type Project = {
  _id: string
  title: string
  createdAt?: number
  /** Set while archived; archived projects are listed only under the Archived section. */
  archivedAt?: number
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
  /** Concepts in this module that are due for review now. */
  dueCount: number
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

/**
 * Describes a module's unit progress, or what it still needs, in a few words.
 * The due count and next unit are shown beside it by the card.
 */
function progressStatus(progress: ModuleProgress | undefined): string {
  if (progress?.hasUnsortedSources) return "Sources aren't in a unit yet"
  if (!progress?.unitCount) return "No material yet"
  return `${progress.taughtCount} of ${progress.unitCount} unit${progress.unitCount === 1 ? "" : "s"} taught`
}

/** Displays project summaries and creates a project through the supplied mutation. */
export function ProjectGrid({ projects, progress, onCreate }: ProjectGridProps) {
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<"recent" | "newest" | "name">("recent")
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const query = search.trim().toLocaleLowerCase()
  const searching = query.length > 0
  /** Orders projects by the selected sort; used for both the active grid and the Archived section. */
  const compare = (a: Project, b: Project) =>
    sort === "name"
      ? a.title.localeCompare(b.title)
      : sort === "recent"
        ? (progress?.[b._id]?.lastStudiedAt ?? 0) - (progress?.[a._id]?.lastStudiedAt ?? 0) ||
          (b.createdAt ?? 0) - (a.createdAt ?? 0)
        : (b.createdAt ?? 0) - (a.createdAt ?? 0)
  /** Returns whether a project title contains the current search text. */
  const matches = (project: Project) =>
    project.title.toLocaleLowerCase().includes(query)
  const allProjects = projects ?? []
  const active = allProjects
    .filter((project) => !isArchived(project) && matches(project))
    .toSorted(compare)
  const archived = allProjects.filter(isArchived)
  const archivedMatches = archived.filter(matches).toSorted(compare)
  // Search reaches archived projects only here, so the section opens to show matches.
  const archivedOpen = archivedExpanded || (searching && archivedMatches.length > 0)
  const emptyActiveTitle = !searching
    ? "All projects are archived"
    : archivedMatches.length > 0
      ? "No active projects match"
      : "No matching projects"
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

  const hasProjects = Boolean(projects && projects.length > 0)

  return (
    <section>
      {/* One row on wide screens; on a phone the search drops to its own full-width line. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-medium tracking-[-0.03em]">Projects</h1>
        {hasProjects && (
          <div className="relative order-last w-full sm:order-none sm:w-56">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search projects"
              placeholder="Search projects"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-10 rounded-full bg-card pl-10 sm:h-9"
            />
          </div>
        )}
        {hasProjects && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-10 gap-1.5 rounded-full px-3 text-muted-foreground sm:h-9">
                <SortIcon aria-hidden="true" className="size-4" />
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
        )}
        {/* Secondary on purpose: Continue in the Today panel is the page's one primary action. */}
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          className="h-10 gap-1.5 rounded-full px-3.5 sm:h-9"
        >
          <AddIcon aria-hidden="true" size={16} />
          <span>New project</span>
        </Button>
      </div>
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
      ) : (
        <>
          {active.length > 0 ? (
            <>
              <p role="status" className="sr-only">
                {active.length} {active.length === 1 ? "project" : "projects"}
              </p>
              <ul
                aria-label="Projects"
                className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]"
              >
                {active.map((project) => (
                  <ProjectCard
                    key={project._id}
                    project={project}
                    moduleProgress={progress}
                  />
                ))}
              </ul>
            </>
          ) : (
            <div className="py-16 text-center">
              <h2 className="text-lg font-medium">{emptyActiveTitle}</h2>
              {searching ? (
                <Button
                  variant="outline"
                  className="mt-5 h-11"
                  onClick={() => setSearch("")}
                >
                  Clear search
                </Button>
              ) : null}
            </div>
          )}
          {archived.length > 0 && (
            <div className="mt-10">
              <Button
                variant="ghost"
                aria-expanded={archivedOpen}
                aria-controls="archived-projects"
                onClick={() => setArchivedExpanded((expanded) => !expanded)}
                className="h-11 rounded-xl text-muted-foreground"
              >
                Archived ({archived.length})
              </Button>
              <div id="archived-projects" hidden={!archivedOpen} className="mt-3">
                {archivedMatches.length > 0 ? (
                  <ul
                    aria-label="Archived projects"
                    className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]"
                  >
                    {archivedMatches.map((project) => (
                      <ProjectCard
                        key={project._id}
                        project={project}
                        moduleProgress={progress}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="py-6 text-sm text-muted-foreground">
                    No archived projects match.
                  </p>
                )}
              </div>
            </div>
          )}
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

/**
 * Renders one library card: a link to the project with its unit progress, and
 * the project menu. Shows a skeleton line in place of the progress text until
 * the module progress has loaded.
 */
function ProjectCard({
  project,
  moduleProgress,
}: {
  project: Project
  /** Per-module progress; undefined while the library is loading. */
  moduleProgress?: Record<string, ModuleProgress>
}) {
  const progress = moduleProgress?.[project._id]
  return (
    <li className="group/card relative min-w-0 rounded-2xl border border-border bg-card transition-colors hover:bg-muted/50">
      <Link
        href={`/projects/${project._id}`}
        className="flex h-full min-h-30 min-w-0 flex-col gap-3 rounded-2xl p-3.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:p-4"
      >
        {/* The full name wraps instead of being clipped; the card grows to fit it. The floated
            spacer keeps the first line clear of the actions button while later lines use the
            full width, so long single words still fit on a phone. */}
        <h2 className="text-sm leading-snug font-medium tracking-tight break-words sm:text-[0.95rem]">
          <span aria-hidden="true" className="float-right h-5 w-7" />
          {project.title}
        </h2>
        <div className="mt-auto space-y-2.5">
          {/* One segment per unit, filled as far as it has been taught. */}
          <SegmentedBar
            size="sm"
            segments={(progress?.unitProgress ?? []).map((fill, index) => ({
              key: String(index),
              fill,
            }))}
          />
          {moduleProgress ? (
            <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>{progressStatus(progress)}</span>
              {progress?.dueCount ? (
                <span className="font-medium text-foreground/80 tabular-nums">{progress.dueCount} due</span>
              ) : null}
              {progress?.nextUnitTitle ? (
                <span className="sr-only">Next: {progress.nextUnitTitle}</span>
              ) : null}
            </p>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </div>
      </Link>
      {/* Quiet until the card is hovered or focused; always shown where there is no hover. */}
      <div className="absolute top-1.5 right-1.5 z-10 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/card:opacity-100 [@media(hover:hover)]:group-focus-within/card:opacity-100 [@media(hover:hover)]:has-[[aria-expanded=true]]:opacity-100">
        <ProjectActions project={project} />
      </div>
    </li>
  )
}

/** Shows project placeholders at the same compact size as loaded cards. */
function ProjectGridLoading() {
  return (
    <div role="status" aria-label="Loading projects">
      <span className="sr-only">Loading projects</span>
      <div
        aria-hidden="true"
        className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]"
      >
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton
            key={index}
            className="h-30 rounded-2xl bg-card"
          />
        ))}
      </div>
    </div>
  )
}
