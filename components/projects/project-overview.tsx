"use client"

/**
 * A module's home: the one next thing to learn, the learning path of units
 * (weeks or lectures) with their Teach progress, and a way to add this week's
 * material. Practice, sources, and listening are secondary destinations.
 */

import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useState } from "react"

import { AddMaterial } from "@/components/learn/add-material"
import { ProjectActions } from "@/components/projects/project-actions"
import {
  PathConnector,
  PathMarker,
  SegmentedBar,
  pathSegments,
  pathStateLabel,
  type PathState,
} from "@/components/progress/progress-path"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  FileIcon,
  HeadphonesIcon,
  PlusIcon,
  ZapIcon,
} from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** One unit as listed on the module page. */
type UnitRow = FunctionReturnType<typeof api.units.listForProject>["units"][number]

/** Renders project metadata first so an invalid ID does not start dependent queries. */
export function ProjectOverview({ projectId }: { projectId: string }) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })

  if (project === undefined) {
    return (
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-8">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-36 w-full rounded-2xl" />
      </main>
    )
  }
  if (project === null) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-8">
        <h1 className="text-2xl font-semibold">Project not found</h1>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/">Back to library</Link>
        </Button>
      </main>
    )
  }
  return <ModuleOverview project={project} />
}

/** Returns a unit's Teach status in words. */
function unitStatus(unit: UnitRow): string {
  const sources = `${unit.sources.length} source${unit.sources.length === 1 ? "" : "s"}`
  const teach = unit.teach
  if (!teach || teach.sectionCount === 0) return `${sources} · Not started`
  if (teach.completed) return `${sources} · Done`
  return `${sources} · Section ${teach.sectionIndex + 1} of ${teach.sectionCount}`
}

/**
 * Returns one bar segment per section of a unit's outline: taught sections are
 * full, the current one half, and the rest empty, as in the Teach header.
 */
function unitSegments(unit: UnitRow) {
  const teach = unit.teach
  if (!teach?.sectionIds.length) return []
  const taught = new Set(teach.taughtSectionIds)
  return pathSegments(
    teach.sectionIds.map((id, index) => ({
      key: id,
      state: teach.completed
        ? "done"
        : index === teach.sectionIndex
          ? "current"
          : taught.has(id)
            ? "done"
            : "ahead",
    }))
  )
}

/**
 * Picks what to learn next: the most recently studied unfinished unit, then
 * the first unit not yet started.
 */
function nextUnit(units: UnitRow[]): UnitRow | undefined {
  const inProgress = units
    .filter((unit) => unit.teach && unit.teach.sectionCount > 0 && !unit.teach.completed)
    .sort((a, b) => (b.teach?.updatedAt ?? 0) - (a.teach?.updatedAt ?? 0))
  return inProgress[0] ?? units.find((unit) => !unit.teach?.completed && unit.sources.length)
}

/** Renders the module page once its project has loaded. */
function ModuleOverview({ project }: { project: Doc<"projects"> }) {
  const projectId = project._id
  const base = `/projects/${encodeURIComponent(String(projectId))}`
  const data = useQuery(api.units.listForProject, { projectId })
  const createUnit = useMutation(api.units.create)
  const moveSource = useMutation(api.units.moveSource)
  const [adding, setAdding] = useState<{ unitId?: Id<"units"> } | null>(null)
  const [grouping, setGrouping] = useState(false)

  const units = data?.units ?? []
  const next = nextUnit(units)
  const allDone = units.length > 0 && units.every((unit) => unit.teach?.completed)
  const teachHref = (unit: UnitRow) => `${base}/learn/${encodeURIComponent(String(unit.id))}`

  /** Gathers sources imported before units existed into one unit. */
  async function groupUnsorted() {
    if (!data?.unsortedSources.length || grouping) return
    setGrouping(true)
    try {
      const unitId = await createUnit({
        projectId,
        title: "Earlier material",
        titleSource: "auto",
      })
      for (const source of data.unsortedSources)
        await moveSource({ sourceId: source.id, unitId })
    } finally {
      setGrouping(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 text-foreground sm:px-8 sm:py-10">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2 min-h-9">
        <Link href="/">
          <ArrowLeftIcon aria-hidden="true" /> Projects
        </Link>
      </Button>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 font-heading text-3xl font-semibold tracking-tight break-words sm:text-4xl">
          {project.title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="ghost" className="min-h-10 rounded-full">
            <Link href={`/chat?projectId=${encodeURIComponent(String(projectId))}`}>
              Ask Blitz
            </Link>
          </Button>
          <ProjectActions project={project} returnToLibrary />
        </div>
      </header>

      {data === undefined ? (
        <section aria-label="Loading module" className="mt-8 space-y-4">
          <Skeleton className="h-28 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </section>
      ) : (
        <>
          {next ? (
            <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-brand/25 bg-brand/[0.05] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-brand">
                  {next.teach?.sectionCount ? "Continue where you left off" : "Up next"}
                </p>
                <h2 className="mt-1 font-heading text-xl font-semibold break-words">{next.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {next.teach?.currentSectionTitle
                    ? `Section ${next.teach.sectionIndex + 1} of ${next.teach.sectionCount} · ${next.teach.currentSectionTitle}`
                    : next.teach?.sectionCount
                      ? unitStatus(next)
                      : `${next.sources.length} source${next.sources.length === 1 ? "" : "s"} ready to teach`}
                </p>
                <SegmentedBar segments={unitSegments(next)} className="mt-3 max-w-md" />
              </div>
              <Button
                asChild
                className="min-h-11 w-full shrink-0 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85 sm:w-auto"
              >
                <Link href={teachHref(next)}>
                  {next.teach?.sectionCount ? "Continue learning" : "Start learning"}
                  <ArrowRightIcon aria-hidden="true" />
                </Link>
              </Button>
            </section>
          ) : allDone ? (
            <section className="mt-8 flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <h2 className="font-heading text-xl font-semibold">Every unit is taught</h2>
              <Button asChild className="min-h-11 rounded-full px-6">
                <Link href={`${base}/practice`}>Practice</Link>
              </Button>
            </section>
          ) : !units.length && !data.unsortedSources.length && !data.referenceSources.length ? (
            <section className="mt-8 rounded-2xl border border-border bg-card p-6 text-center sm:p-10">
              <h2 className="font-heading text-xl font-semibold">Add your first week</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                Upload a week&apos;s transcripts, slides, and notes. Blitz starts
                teaching them straight away.
              </p>
              <Button
                type="button"
                onClick={() => setAdding({})}
                className="mt-5 min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
              >
                <PlusIcon aria-hidden="true" /> Add material
              </Button>
            </section>
          ) : null}

          {units.length || data.unsortedSources.length ? (
            <section aria-labelledby="learning-path-heading" className="mt-10">
              <div className="flex items-center justify-between gap-3">
                <h2 id="learning-path-heading" className="font-heading text-lg font-semibold">
                  Learning path
                </h2>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAdding({})}
                  className="min-h-10 rounded-full px-4"
                >
                  <PlusIcon aria-hidden="true" /> Add material
                </Button>
              </div>
              <ol className="mt-4 space-y-1">
                {units.map((unit, index) => (
                  <UnitListItem
                    key={unit.id}
                    unit={unit}
                    number={index + 1}
                    state={unit.teach?.completed ? "done" : unit.id === next?.id ? "current" : "ahead"}
                    href={teachHref(unit)}
                    isFirst={index === 0}
                    isLast={index === units.length - 1}
                    onAddMaterial={() => setAdding({ unitId: unit.id })}
                  />
                ))}
              </ol>
              {data.unsortedSources.length ? (
                <div className="mt-6 flex flex-col gap-3 rounded-xl border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {data.unsortedSources.length} earlier source
                    {data.unsortedSources.length === 1 ? " isn't" : "s aren't"} in a unit yet.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={grouping}
                    onClick={() => void groupUnsorted()}
                    className="min-h-10 rounded-full px-4"
                  >
                    {grouping ? "Grouping…" : "Group into a unit"}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {data.referenceSources.length ? (
            <section aria-labelledby="reference-heading" className="mt-10">
              <h2 id="reference-heading" className="font-heading text-lg font-semibold">
                Reference books
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The tutor searches these for every unit to add depth and extra examples.
              </p>
              <ul className="mt-3 space-y-1.5">
                {data.referenceSources.map((source) => (
                  <li key={source.id}>
                    <Link
                      href={`${base}/sources/${encodeURIComponent(String(source.id))}`}
                      className="text-sm underline-offset-4 hover:underline"
                    >
                      {source.filename}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <nav aria-label="Module areas" className="mt-10 grid gap-2 sm:grid-cols-3">
            {[
              {
                href: `${base}/practice`,
                label: "Practice",
                detail: "Drills and mock exams",
                icon: ZapIcon,
              },
              {
                href: `${base}/sources`,
                label: "Sources",
                detail: `${units.reduce((sum, unit) => sum + unit.sources.length, 0) + data.unsortedSources.length + data.referenceSources.length} files and links`,
                icon: FileIcon,
              },
              {
                href: `${base}/listen`,
                label: "Listen",
                detail: "Podcasts made from your units",
                icon: HeadphonesIcon,
              },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex min-h-16 items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <item.icon aria-hidden="true" className="size-5 shrink-0 text-brand" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{item.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>
                </span>
              </Link>
            ))}
          </nav>
        </>
      )}

      {adding ? (
        <AddMaterial
          projectId={projectId}
          units={units.map((unit) => ({ id: unit.id, title: unit.title }))}
          {...(adding.unitId ? { defaultUnitId: adding.unitId } : {})}
          open
          onOpenChange={(open) => {
            if (!open) setAdding(null)
          }}
        />
      ) : null}
    </main>
  )
}

/** Props for one unit row. */
type UnitListItemProps = {
  unit: UnitRow
  number: number
  /** Where the unit stands on the path: taught, up next, or ahead. */
  state: PathState
  href: string
  isFirst: boolean
  isLast: boolean
  onAddMaterial: () => void
}

/** Renders one unit with its progress and an actions menu. */
function UnitListItem({ unit, number, state, href, isFirst, isLast, onAddMaterial }: UnitListItemProps) {
  const rename = useMutation(api.units.rename)
  const move = useMutation(api.units.move)
  const remove = useMutation(api.units.remove)
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState(unit.title)
  const [error, setError] = useState("")
  const segments = unitSegments(unit)

  /** Saves a new title from the rename dialog. */
  async function saveTitle() {
    try {
      await rename({ unitId: unit.id, title })
      setRenaming(false)
    } catch {
      setError("The title could not be saved. Try again.")
    }
  }

  return (
    <li
      className={cn(
        "group relative flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted/60",
        state === "current" && "bg-brand/[0.06]"
      )}
    >
      {/* The path joins each unit's marker to the next; taught stretches are filled. */}
      {!isLast ? (
        <PathConnector done={state === "done"} className="top-[48px] -bottom-[16px] left-[27.5px] z-10" />
      ) : null}
      <PathMarker state={state} number={number} size="md" />
      <div className="min-w-0 flex-1 pt-0.5">
        <Link
          href={href}
          aria-current={state === "current" ? "step" : undefined}
          className={cn(
            "block font-medium break-words after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring",
            state === "ahead" && "text-foreground/85"
          )}
        >
          {unit.title}
          <span className="sr-only"> ({pathStateLabel(state)})</span>
        </Link>
        <p className="mt-0.5 text-xs text-muted-foreground">{unitStatus(unit)}</p>
        <SegmentedBar size="sm" segments={segments} className="mt-2 max-w-sm" />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="relative z-10 min-h-10 min-w-10 rounded-full"
            aria-label={`Actions for ${unit.title}`}
          >
            ⋯
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onAddMaterial}>Add material</DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setTitle(unit.title)
              setError("")
              setRenaming(true)
            }}
          >
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={isFirst}
            onSelect={() => void move({ unitId: unit.id, direction: "earlier" })}
          >
            Move earlier
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isLast}
            onSelect={() => void move({ unitId: unit.id, direction: "later" })}
          >
            Move later
          </DropdownMenuItem>
          {!unit.sources.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive data-[highlighted]:text-destructive"
                onSelect={() => void remove({ unitId: unit.id })}
              >
                Delete empty unit
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename unit</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void saveTitle()
            }}
            className="space-y-3"
          >
            <label htmlFor={`unit-title-${unit.id}`} className="sr-only">
              Unit title
            </label>
            <Input
              id={`unit-title-${unit.id}`}
              value={title}
              maxLength={160}
              onChange={(event) => setTitle(event.target.value)}
              className="min-h-11"
              autoFocus
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!title.trim()}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </li>
  )
}
