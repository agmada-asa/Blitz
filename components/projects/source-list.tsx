"use client"

/**
 * The module's source files, grouped the way the learning path is: by unit,
 * then reference books, files not in a unit, and exam papers. Each file can
 * be opened, downloaded, renamed, moved to another unit, or deleted. Upload
 * and preparation state comes from the Sources page through props.
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
import { FileIcon, LoadingIcon, RotateLeftIcon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
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
  const type =
    source.originalUrl && !source.relativeKey
      ? "Link"
      : source.kind === "pdf"
        ? "PDF"
        : source.kind === "markdown"
          ? "Markdown"
          : source.kind === "paste"
            ? "Pasted text"
            : source.kind === "text"
              ? "Text"
              : undefined
  const added = source.createdAt
    ? `Added ${new Date(source.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : undefined
  return [type, formatSize(source.sizeBytes), added].filter(Boolean).join(" · ")
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

/** Renders the module's files grouped by unit, with a filter for long lists. */
export function SourceList({
  projectId,
  sources,
  units,
  ingestion,
  preparation,
  onRetryIngestion,
}: SourceListProps) {
  const [filter, setFilter] = useState("")
  const query = filter.trim().toLowerCase()
  const shown = query
    ? sources.filter((source) => source.filename.toLowerCase().includes(query))
    : sources
  const groups = groupSources(shown, units)

  if (!sources.length) return <p className="mt-4 text-sm text-muted-foreground">No sources yet.</p>

  return (
    <div className="mt-4 space-y-6">
      {sources.length > FILTER_THRESHOLD ? (
        <div>
          <label htmlFor="source-filter" className="sr-only">
            Find a file
          </label>
          <Input
            id="source-filter"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a file"
            className="min-h-11"
          />
        </div>
      ) : null}
      {groups.length ? (
        groups.map((group) => (
          <section key={group.key} aria-labelledby={`source-group-${group.key}`}>
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={`source-group-${group.key}`} className="font-medium break-words">
                {group.title}
              </h3>
              <span className="shrink-0 text-xs text-muted-foreground">
                {group.sources.length} {group.sources.length === 1 ? "file" : "files"}
              </span>
            </div>
            {group.note ? <p className="mt-0.5 text-xs text-muted-foreground">{group.note}</p> : null}
            <ul className="mt-2 divide-y divide-border/70 rounded-xl border border-border">
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
          </section>
        ))
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

/** Returns the move dialog's select value for a file's current place. */
function placementValue(source: ProjectFileSource): string {
  if (source.placement?.kind === "unit") return String(source.placement.unitId)
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
  const [destination, setDestination] = useState(placementValue(source))
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
    setDestination(placementValue(source))
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

  return (
    <li className="p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <FileIcon className="mt-0.5 shrink-0 text-muted-foreground" size={20} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="font-medium break-words hover:text-brand focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {source.filename}
          </Link>
          <p className="mt-0.5 text-xs text-muted-foreground">{sourceDetails(source)}</p>
        </div>
        <Badge variant={state.variant} className="mt-0.5 shrink-0">
          {state.label}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="-my-1.5 min-h-10 min-w-10 shrink-0 rounded-full"
              aria-label={`Actions for ${source.filename}`}
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
        <p className="mt-3 rounded-md bg-muted/60 px-3 py-2 text-sm text-muted-foreground">
          The original is saved. Blitz cannot read this file type yet.
        </p>
      ) : null}
      {state.label === "Needs attention" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
                <DialogTitle>Move {source.filename}</DialogTitle>
                <DialogDescription>
                  A unit&apos;s Teach session covers new files once you restart it.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <label htmlFor={`source-destination-${sourceId}`} className="text-sm font-medium">
                  Move to
                </label>
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
                  disabled={busy || destination === placementValue(source)}
                  onClick={() => void saveMove()}
                >
                  {busy ? "Moving…" : "Move file"}
                </Button>
              </DialogFooter>
            </div>
          ) : dialog === "delete" ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>Delete {source.filename}?</DialogTitle>
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
