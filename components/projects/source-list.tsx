"use client"

/**
 * The module's source files, grouped the way the learning path is: by unit,
 * then reference books, files not in a unit, and exam papers. Long lists
 * start with each group folded so the units read as an index. Each file opens
 * from anywhere on its row and can be downloaded, renamed, moved to another
 * unit, or deleted. Upload and preparation state comes from the Sources page
 * through props.
 */

import Link from "next/link"
import { useMutation } from "convex/react"
import { useState } from "react"

import type {
  ProjectFileIngestion,
  ProjectFilePreparation,
  ProjectFileSource,
  ProjectFileUnit,
} from "@/components/projects/project-files"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  ArrowRightIcon,
  FileIcon,
  LayersIcon,
  LinkIcon,
  LoadingIcon,
  RotateLeftIcon,
  SearchIcon,
} from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { sourceDisplayName, sourceTypeLabel } from "@/lib/source-display"
import { cn } from "@/lib/utils"

/** Files listed before the filter box appears; short lists are easy to scan. */
const FILTER_THRESHOLD = 6

/** Select value for the module's reference books. */
const REFERENCE = "reference"

/** Select value for leaving a file outside every unit. */
const UNSORTED = "unsorted"

/** Props for the grouped source list. */
type SourceListProps = {
  projectId: string
  sources: ProjectFileSource[]
  units: ProjectFileUnit[]
  ingestion: ProjectFileIngestion[]
  preparation: ProjectFilePreparation[]
  onRetryIngestion?: (sourceId: string) => void | Promise<void>
}

/** A failure whose message is already written for the learner. */
class LearnerFacingError extends Error {}

/** One heading and its files. */
type SourceGroup = { key: string; title: string; note?: string; sources: ProjectFileSource[] }

/** Formats byte sizes without exposing implementation details in the file list. */
export function formatSize(sizeBytes?: number): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return undefined
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Returns an accessible label and badge style for each source lifecycle state. */
function sourceStatus(
  source: ProjectFileSource,
  ingestionJob: ProjectFileIngestion | undefined,
  preparationJob: ProjectFilePreparation | undefined
) {
  if (source.unsupported && !preparationJob)
    return { label: "Original saved", variant: "outline" as const }
  if (
    ingestionJob?.status === "failed" ||
    preparationJob?.status === "failed" ||
    preparationJob?.leaseExpired ||
    source.status === "failed"
  )
    return { label: "Needs attention", variant: "destructive" as const }
  if (ingestionJob?.status === "running" || ingestionJob?.status === "queued")
    return {
      label: ingestionJob.status === "queued" ? "Queued" : "Ingesting",
      variant: "outline" as const,
    }
  if (preparationJob?.status === "queued" || preparationJob?.status === "leased")
    return {
      label: preparationJob.status === "queued" ? "Queued" : "Preparing",
      variant: "outline" as const,
    }
  if (preparationJob?.status === "completed")
    return { label: "Ready", variant: "secondary" as const }
  if (source.status === "processing") return { label: "Preparing", variant: "outline" as const }
  return { label: "Ready", variant: "secondary" as const }
}

/** Returns the most useful recoverable error for a source row. */
function sourceError(
  source: ProjectFileSource,
  ingestionJob: ProjectFileIngestion | undefined,
  preparationJob: ProjectFilePreparation | undefined
): string | undefined {
  if (ingestionJob?.error) return ingestionJob.error
  if (preparationJob?.error) return preparationJob.error
  if (preparationJob?.leaseExpired) return "Preparation stopped before it finished. Retry to resume."
  return source.error
}

/** Returns preparation progress as a percentage when a chunk count is known. */
function preparationProgress(preparationJob: ProjectFilePreparation | undefined): number | undefined {
  if (
    preparationJob?.status === "completed" ||
    preparationJob?.totalChunks === undefined ||
    preparationJob.totalChunks <= 0
  )
    return undefined
  return Math.min(100, ((preparationJob.nextChunkOrdinal ?? 0) / preparationJob.totalChunks) * 100)
}

/** Describes a file's type, size, and upload date in one short line. */
function sourceDetails(source: ProjectFileSource): string {
  const added = source.createdAt
    ? `Added ${new Date(source.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : undefined
  return [sourceTypeLabel(source), formatSize(source.sizeBytes), added].filter(Boolean).join(" · ")
}

/** Draws the row icon for a file's type: slides, links and web pages, or a plain file. */
function SourceTypeIcon({ source }: { source: ProjectFileSource }) {
  const type = sourceTypeLabel(source)
  const props = { className: "shrink-0 text-muted-foreground", size: 18, "aria-hidden": true } as const
  if (type === "Slides") return <LayersIcon {...props} />
  if (type === "Link" || type === "Web page") return <LinkIcon {...props} />
  return <FileIcon {...props} />
}

/**
 * Sorts files into the learning path's units in order, then reference books,
 * files not in a unit, and exam papers. Empty groups are left out.
 */
function groupSources(sources: ProjectFileSource[], units: ProjectFileUnit[]): SourceGroup[] {
  const known = new Set(units.map((unit) => String(unit.id)))
  const inUnit = (unitId: string) =>
    sources.filter((source) => source.placement?.kind === "unit" && String(source.placement.unitId) === unitId)
  const groups: SourceGroup[] = units.map((unit) => ({
    key: String(unit.id),
    title: unit.title,
    sources: inUnit(String(unit.id)),
  }))
  groups.push(
    {
      key: REFERENCE,
      title: "Reference books",
      note: "The tutor searches these for every unit.",
      sources: sources.filter((source) => source.placement?.kind === "reference"),
    },
    {
      key: UNSORTED,
      title: "Not in a unit",
      sources: sources.filter(
        (source) =>
          !source.placement ||
          source.placement.kind === "unsorted" ||
          // A unit removed while this page was open: show its files rather than hide them.
          (source.placement.kind === "unit" && !known.has(String(source.placement.unitId)))
      ),
    },
    {
      key: "exam",
      title: "Exam papers",
      note: "Delete these by deleting their paper in Practice.",
      sources: sources.filter((source) => source.placement?.kind === "exam"),
    }
  )
  return groups.filter((group) => group.sources.length)
}

/**
 * Renders the module's files grouped by unit, with a filter for long lists.
 * In a long list every group starts folded, so the page reads as an index of
 * units; a search opens every group with a match.
 */
export function SourceList({
  projectId,
  sources,
  units,
  ingestion,
  preparation,
  onRetryIngestion,
}: SourceListProps) {
  const [filter, setFilter] = useState("")
  // Groups the learner has opened or closed; untouched groups use the default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({})
  const query = filter.trim().toLowerCase()
  const shown = query
    ? sources.filter(
        (source) =>
          source.filename.toLowerCase().includes(query) ||
          sourceDisplayName(source.filename).toLowerCase().includes(query)
      )
    : sources
  const groups = groupSources(shown, units)
  const long = sources.length > FILTER_THRESHOLD

  if (!sources.length) return <p className="text-sm text-muted-foreground">No sources yet.</p>

  /** Whether a group's files are showing: searches open every match, short lists stay open. */
  const isOpen = (key: string) => Boolean(query) || (toggled[key] ?? !long)

  return (
    <div className="space-y-4">
      {long ? (
        <div className="relative sm:max-w-sm">
          <label htmlFor="source-filter" className="sr-only">
            Find a file
          </label>
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="source-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a file"
            className="min-h-11 rounded-full pl-10"
          />
        </div>
      ) : null}
      {groups.length ? (
        <div className="space-y-2">
          {groups.map((group) => {
            const open = isOpen(group.key)
            const listId = `source-group-${group.key}-files`
            return (
              <section
                key={group.key}
                aria-labelledby={`source-group-${group.key}`}
                className="rounded-xl border border-border bg-card"
              >
                <h3 id={`source-group-${group.key}`}>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={listId}
                    disabled={Boolean(query)}
                    onClick={() => setToggled((current) => ({ ...current, [group.key]: !open }))}
                    className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent sm:px-4"
                  >
                    <ArrowRightIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                        open && "rotate-90"
                      )}
                    />
                    <span className="min-w-0 flex-1 font-medium break-words">{group.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {group.sources.length} {group.sources.length === 1 ? "file" : "files"}
                    </span>
                  </button>
                </h3>
                <div id={listId} hidden={!open} className="border-t border-border/70">
                  {group.note ? (
                    <p className="px-3 pt-2.5 text-xs text-muted-foreground sm:px-4">{group.note}</p>
                  ) : null}
                  <ul className="divide-y divide-border/70">
                    {group.sources.map((source) => (
                      <SourceRow
                        key={String(source._id)}
                        projectId={projectId}
                        source={source}
                        units={units}
                        ingestionJob={ingestion.find((item) => item.sourceId === String(source._id))}
                        preparationJob={preparation.find((item) => item.sourceId === String(source._id))}
                        onRetryIngestion={onRetryIngestion}
                      />
                    ))}
                  </ul>
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No files match “{filter.trim()}”.</p>
      )}
    </div>
  )
}

/** Props for one file row. */
type SourceRowProps = {
  projectId: string
  source: ProjectFileSource
  units: ProjectFileUnit[]
  ingestionJob?: ProjectFileIngestion
  preparationJob?: ProjectFilePreparation
  onRetryIngestion?: (sourceId: string) => void | Promise<void>
}

/** Which management dialog a row has open. */
type RowDialog = "rename" | "move" | "delete" | null

/**
 * Returns the move dialog's select value for a file's current place. A file
 * whose unit was just removed counts as not in a unit, as it is listed.
 */
function placementValue(source: ProjectFileSource, units: ProjectFileUnit[]): string {
  const placement = source.placement
  if (placement?.kind === "unit" && units.some((unit) => String(unit.id) === String(placement.unitId)))
    return String(placement.unitId)
  if (source.placement?.kind === "reference") return REFERENCE
  return UNSORTED
}

/** Renders one file with its state, preparation progress, and actions menu. */
function SourceRow({
  projectId,
  source,
  units,
  ingestionJob,
  preparationJob,
  onRetryIngestion,
}: SourceRowProps) {
  const rename = useMutation(api.sources.rename)
  const moveSource = useMutation(api.units.moveSource)
  const markReference = useMutation(api.sources.markReference)
  const [dialog, setDialog] = useState<RowDialog>(null)
  const [filename, setFilename] = useState(source.filename)
  const [destination, setDestination] = useState(placementValue(source, units))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState("")

  const sourceId = String(source._id)
  const isExam = source.placement?.kind === "exam"
  const state = sourceStatus(source, ingestionJob, preparationJob)
  const progress = preparationProgress(preparationJob)
  const href = `/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}`
  const downloadHref = `/api/sources/file?projectId=${encodeURIComponent(projectId)}&sourceId=${encodeURIComponent(sourceId)}`

  /** Opens one management dialog with fresh form state. */
  function open(next: Exclude<RowDialog, null>) {
    setFilename(source.filename)
    setDestination(placementValue(source, units))
    setError("")
    setDialog(next)
  }

  /** Runs a dialog action, closing on success and keeping the dialog open with an error otherwise. */
  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true)
    setError("")
    try {
      await action()
      setDialog(null)
    } catch (caught) {
      // Convex errors carry request details, so only route messages are shown as is.
      setError(caught instanceof LearnerFacingError ? caught.message : failure)
    } finally {
      setBusy(false)
    }
  }

  /** Saves the new file name. */
  const saveName = () =>
    run(async () => {
      await rename({ sourceId: source._id as Id<"sources">, filename })
    }, "The name could not be saved. Try again.")

  /** Moves the file to the chosen unit, the reference books, or out of every unit. */
  const saveMove = () =>
    run(async () => {
      const id = source._id as Id<"sources">
      if (destination === REFERENCE) await markReference({ sourceId: id })
      else
        await moveSource({
          sourceId: id,
          ...(destination === UNSORTED ? {} : { unitId: destination as Id<"units"> }),
        })
    }, "The file could not be moved. Try again.")

  /** Deletes the file through the route that also removes the stored original. */
  const confirmDelete = () =>
    run(async () => {
      const response = await fetch("/api/sources/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, sourceId }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string }
        throw new LearnerFacingError(payload.error || "The file could not be deleted. Try again.")
      }
    }, "The file could not be deleted. Try again.")

  /** Retries extraction and keeps a failure visible beside the file. */
  async function retry() {
    if (!onRetryIngestion) return
    setRetrying(true)
    setRetryError("")
    try {
      await onRetryIngestion(sourceId)
    } catch (caught) {
      setRetryError(
        caught instanceof Error && caught.message.trim() ? caught.message : "The source could not be retried."
      )
    } finally {
      setRetrying(false)
    }
  }

  const name = sourceDisplayName(source.filename)

  return (
    <li className="relative px-3 py-2.5 transition-colors hover:bg-muted/40 sm:px-4">
      <div className="flex items-center gap-3">
        <SourceTypeIcon source={source} />
        <div className="min-w-0 flex-1">
          {/* The link's hit area covers the whole row; the menu sits above it. */}
          <Link
            href={href}
            title={source.filename === name ? undefined : source.filename}
            className="line-clamp-2 text-sm font-medium break-words after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {name}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">{sourceDetails(source)}</p>
        </div>
        {/* Ready is the normal state, so only states that need a look get a badge. */}
        {state.label !== "Ready" ? (
          <Badge variant={state.variant} className="shrink-0">
            {state.label}
          </Badge>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="relative z-10 -my-1.5 min-h-10 min-w-10 shrink-0 rounded-full"
              aria-label={`Actions for ${name}`}
            >
              ⋯
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={href}>Open</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={downloadHref} download>
                Download
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => open("rename")}>Rename</DropdownMenuItem>
            {!isExam ? (
              <>
                <DropdownMenuItem onSelect={() => open("move")}>Move to…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive data-[highlighted]:text-destructive"
                  onSelect={() => open("delete")}
                >
                  Delete…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {progress !== undefined ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Preparing study material</span>
            <span>{Math.round(progress)}%</span>
          </div>
          <Progress value={progress} aria-label={`Preparation ${Math.round(progress)} percent complete`} />
        </div>
      ) : null}
      {source.unsupported && !preparationJob ? (
        <p className="mt-1 pl-[30px] text-xs text-muted-foreground">
          Blitz cannot read this file type yet, so it is not used for teaching.
        </p>
      ) : null}
      {state.label === "Needs attention" ? (
        <div className="relative z-10 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>
            {sourceError(source, ingestionJob, preparationJob) ||
              "This file could not be prepared for retrieval."}
          </span>
          {retryError ? <span className="basis-full text-xs">{retryError}</span> : null}
          {onRetryIngestion ? (
            <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
              {retrying ? (
                <LoadingIcon className="animate-spin motion-reduce:animate-none" size={14} />
              ) : (
                <RotateLeftIcon size={14} />
              )}
              {retrying ? "Retrying…" : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(next) => !busy && !next && setDialog(null)}>
        <DialogContent>
          {dialog === "rename" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void saveName()
              }}
              className="space-y-4"
            >
              <DialogHeader>
                <DialogTitle>Rename file</DialogTitle>
              </DialogHeader>
              <label htmlFor={`source-name-${sourceId}`} className="sr-only">
                File name
              </label>
              <Input
                id={`source-name-${sourceId}`}
                value={filename}
                maxLength={200}
                onChange={(event) => setFilename(event.target.value)}
                className="min-h-11"
                autoFocus
              />
              <DialogError message={error} />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !filename.trim()}>
                  Save
                </Button>
              </DialogFooter>
            </form>
          ) : dialog === "move" ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>Move {name}</DialogTitle>
                <DialogDescription>
                  A unit&apos;s Teach session covers new files once you restart it.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`source-destination-${sourceId}`}>Move to</Label>
                <Select value={destination} onValueChange={setDestination}>
                  <SelectTrigger id={`source-destination-${sourceId}`} className="min-h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {units.map((unit) => (
                      <SelectItem key={String(unit.id)} value={String(unit.id)}>
                        {unit.title}
                      </SelectItem>
                    ))}
                    <SelectItem value={REFERENCE}>Reference books</SelectItem>
                    <SelectItem value={UNSORTED}>Not in a unit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <DialogError message={error} />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy || destination === placementValue(source, units)}
                  onClick={() => void saveMove()}
                >
                  {busy ? "Moving…" : "Move file"}
                </Button>
              </DialogFooter>
            </div>
          ) : dialog === "delete" ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>Delete {name}?</DialogTitle>
                <DialogDescription>
                  This deletes the file from Blitz and from the module&apos;s folder on this
                  computer. Questions made only from it leave your drills. Your answers and XP
                  still count.
                </DialogDescription>
              </DialogHeader>
              <DialogError message={error} />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
                  {busy ? "Deleting…" : "Delete file"}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </li>
  )
}

/** Shows a dialog action's failure, or nothing. */
function DialogError({ message }: { message: string }) {
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null
}
