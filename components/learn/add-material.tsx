"use client"

/**
 * Adds course material to a module: files, pasted notes, or a public link,
 * filed under a new unit (the default, one per week or lecture) or an
 * existing one. Every entry method goes through the upload route, so each
 * source gets the same extraction, passages, and citations.
 *
 * Material is ready to teach as soon as it is extracted, usually within
 * seconds, so the dialog ends with a direct `Start learning` action.
 */

import { useMutation } from "convex/react"
import { useRouter } from "next/navigation"
import { useRef, useState, type DragEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CheckIcon, FileIcon, LoadingIcon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { extractSourceResponse } from "@/lib/client/extract-source"
import { suggestUnitTitle } from "@/lib/teach"
import { cn } from "@/lib/utils"

/** Value of the unit picker that creates a new unit. */
const NEW_UNIT = "new"

/** Accepted file types, matching what the upload route can extract. */
const ACCEPT =
  ".pdf,.pptx,.txt,.vtt,.srt,.md,.markdown,.html,.htm,.csv,.json,.py,.ts,.tsx,.js,.jsx,.java,.c,.cpp,.h,.go,.rs,.sql,.sh"

/** One file's progress through the upload. */
type UploadRow = {
  name: string
  state: "waiting" | "uploading" | "ready" | "failed"
  detail?: string
}

/** Props for the dialog. */
type AddMaterialProps = {
  projectId: Id<"projects">
  units: Array<{ id: Id<"units">; title: string }>
  /** Pre-selects an existing unit instead of creating one. */
  defaultUnitId?: Id<"units">
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Reads a JSON `error` from a failed response, with a fallback. */
async function responseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  return typeof payload?.error === "string" ? payload.error : fallback
}

/**
 * Uploads one file or text body to a unit.
 * @throws With a learner-facing message when the upload or extraction fails.
 */
async function uploadToUnit(input: {
  projectId: Id<"projects">
  unitId: Id<"units">
  file: File
  sourceUrl?: string
}): Promise<{ duplicate: boolean; reference: boolean; inThisUnit: boolean }> {
  const response = await fetch("/api/sources/upload", {
    method: "POST",
    headers: {
      "x-blitz-project-id": String(input.projectId),
      "x-blitz-unit-id": String(input.unitId),
      "x-blitz-filename": encodeURIComponent(input.file.name),
      ...(input.sourceUrl ? { "x-blitz-source-url": encodeURIComponent(input.sourceUrl) } : {}),
      ...(input.file.type ? { "content-type": input.file.type } : {}),
    },
    body: input.file,
  })
  if (!response.ok)
    throw new Error(await responseError(response, "This file could not be uploaded."))
  const result = (await response.json()) as {
    duplicate?: boolean
    reference?: boolean
    unitId?: string
    unsupported?: boolean
    extractionError?: string
  }
  if (result.unsupported)
    throw new Error(result.extractionError || "Blitz can't read this file type yet.")
  return {
    duplicate: Boolean(result.duplicate),
    reference: Boolean(result.reference),
    // A duplicate counts for this unit only when its existing copy is here.
    inThisUnit: !result.duplicate || result.unitId === String(input.unitId),
  }
}

/** Renders the add-material dialog. */
export function AddMaterial({
  projectId,
  units,
  defaultUnitId,
  open,
  onOpenChange,
}: AddMaterialProps) {
  const router = useRouter()
  const createUnit = useMutation(api.units.create)
  const removeUnit = useMutation(api.units.remove)
  const inputRef = useRef<HTMLInputElement>(null)
  const [target, setTarget] = useState<string>(defaultUnitId ?? NEW_UNIT)
  const [rows, setRows] = useState<UploadRow[]>([])
  const [paste, setPaste] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [dragging, setDragging] = useState(false)
  const [doneUnitId, setDoneUnitId] = useState<Id<"units">>()

  /** Clears progress when the dialog closes so the next visit starts fresh. */
  function changeOpen(next: boolean) {
    if (busy) return
    if (!next) {
      setRows([])
      setPaste("")
      setUrl("")
      setError("")
      setDoneUnitId(undefined)
      setTarget(defaultUnitId ?? NEW_UNIT)
    }
    onOpenChange(next)
  }

  /** Returns the chosen unit, creating a new one titled from the material. */
  async function resolveUnit(names: string[]): Promise<Id<"units">> {
    if (target !== NEW_UNIT) return target as Id<"units">
    const unitId = await createUnit({
      projectId,
      title: suggestUnitTitle(names, units.length + 1),
      titleSource: "auto",
    })
    // Further additions in this visit go to the same new unit.
    setTarget(unitId)
    return unitId
  }

  /** Uploads files one at a time so a failure never blocks the rest. */
  async function addFiles(files: File[]) {
    if (!files.length || busy) return
    setBusy(true)
    setError("")
    const initial: UploadRow[] = files.map((file) => ({ name: file.name, state: "waiting" }))
    setRows(initial)
    try {
      const unitId = await resolveUnit(files.map((file) => file.name))
      const next = [...initial]
      let succeeded = 0
      // Reference books leave the unit, so only teachable files make it worth opening.
      let teachable = 0
      for (const [index, file] of files.entries()) {
        next[index] = { ...next[index], state: "uploading" }
        setRows([...next])
        try {
          const { duplicate, reference, inThisUnit } = await uploadToUnit({
            projectId,
            unitId,
            file,
          })
          next[index] = {
            ...next[index],
            state: "ready",
            ...(reference
              ? { detail: "Saved as a reference book that backs up every unit" }
              : duplicate && !inThisUnit
                ? { detail: "Already in another unit of this module" }
                : duplicate
                  ? { detail: "Already in this module" }
                  : {}),
          }
          succeeded += 1
          if (!reference && inThisUnit) teachable += 1
        } catch (uploadError) {
          next[index] = {
            ...next[index],
            state: "failed",
            detail: uploadError instanceof Error ? uploadError.message : "Upload failed",
          }
        }
        setRows([...next])
      }
      if (teachable) setDoneUnitId(unitId)
      else if (!succeeded) setError("None of these files could be added.")
      // A new unit that only received reference books is empty; remove it.
      // `units.remove` refuses units that still have sources.
      if (!teachable && target === NEW_UNIT) await removeUnit({ unitId }).catch(() => undefined)
    } catch {
      setError("A unit could not be created for this material. Try again.")
    } finally {
      setBusy(false)
    }
  }

  /** Saves pasted notes as a Markdown source. */
  async function addPaste() {
    const text = paste.trim()
    if (!text || busy) return
    setBusy(true)
    setError("")
    try {
      const firstLine = text.split("\n")[0].replace(/^#+\s*/, "").trim().slice(0, 60)
      const name = `${firstLine || "Pasted notes"}.md`
      const unitId = await resolveUnit([name])
      await uploadToUnit({
        projectId,
        unitId,
        file: new File([text], name, { type: "text/markdown" }),
      })
      setRows([{ name, state: "ready" }])
      setPaste("")
      setDoneUnitId(unitId)
    } catch (pasteError) {
      setError(pasteError instanceof Error ? pasteError.message : "Notes could not be saved.")
    } finally {
      setBusy(false)
    }
  }

  /** Fetches a public link, extracts its text, and saves it as a source. */
  async function addLink() {
    const link = url.trim()
    if (!link || busy) return
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/sources/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link }),
      })
      if (!response.ok)
        throw new Error(await responseError(response, "That link could not be fetched."))
      const finalUrl = response.headers.get("x-source-url") ?? link
      const source = await extractSourceResponse(response, finalUrl)
      const name = `${source.filename.replace(/\.[A-Za-z0-9]{1,5}$/, "")}.md`
      const unitId = await resolveUnit([name])
      await uploadToUnit({
        projectId,
        unitId,
        file: new File([source.text], name, { type: "text/markdown" }),
        sourceUrl: finalUrl,
      })
      setRows([{ name, state: "ready" }])
      setUrl("")
      setDoneUnitId(unitId)
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : "That link could not be added.")
    } finally {
      setBusy(false)
    }
  }

  /** Accepts files dropped on the drop zone. */
  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    void addFiles(Array.from(event.dataTransfer.files))
  }

  const teachHref = doneUnitId
    ? `/projects/${encodeURIComponent(String(projectId))}/learn/${encodeURIComponent(String(doneUnitId))}`
    : undefined

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add material</DialogTitle>
          <DialogDescription>
            Add a week&apos;s transcripts, slides, and notes together. Blitz can
            teach them as soon as they upload.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="material-unit" className="text-sm font-medium">
            Add to
          </label>
          <Select value={target} onValueChange={setTarget} disabled={busy || Boolean(doneUnitId)}>
            <SelectTrigger id="material-unit" className="min-h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_UNIT}>New unit</SelectItem>
              {units.map((unit) => (
                <SelectItem key={unit.id} value={unit.id}>
                  {unit.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Tabs defaultValue="files">
          <TabsList className="w-full">
            <TabsTrigger value="files" className="flex-1">Files</TabsTrigger>
            <TabsTrigger value="paste" className="flex-1">Paste</TabsTrigger>
            <TabsTrigger value="link" className="flex-1">Link</TabsTrigger>
          </TabsList>
          <TabsContent value="files" className="mt-3">
            <div
              onDragEnter={(event) => {
                if (!event.dataTransfer.types.includes("Files")) return
                event.preventDefault()
                setDragging(true)
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              className={cn(
                "flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-8 text-center transition-colors",
                dragging && "border-brand bg-brand/5"
              )}
            >
              <FileIcon aria-hidden="true" className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Drop PDFs, slides, transcripts (.txt, .vtt, .srt), or notes here
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                className="min-h-11 rounded-full px-5"
              >
                Choose files
              </Button>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  void addFiles(Array.from(event.target.files ?? []))
                  event.target.value = ""
                }}
              />
            </div>
          </TabsContent>
          <TabsContent value="paste" className="mt-3 space-y-3">
            <label htmlFor="material-paste" className="sr-only">
              Notes to add
            </label>
            <Textarea
              id="material-paste"
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              placeholder="Paste lecture notes or a transcript"
              className="min-h-40"
              disabled={busy}
            />
            <Button
              type="button"
              disabled={busy || !paste.trim()}
              onClick={() => void addPaste()}
              className="min-h-11 rounded-full px-5"
            >
              Add notes
            </Button>
          </TabsContent>
          <TabsContent value="link" className="mt-3 space-y-3">
            <label htmlFor="material-link" className="sr-only">
              Link to add
            </label>
            <Input
              id="material-link"
              type="url"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              className="min-h-11"
              disabled={busy}
            />
            <Button
              type="button"
              disabled={busy || !url.trim()}
              onClick={() => void addLink()}
              className="min-h-11 rounded-full px-5"
            >
              Add link
            </Button>
          </TabsContent>
        </Tabs>

        {rows.length ? (
          <ul aria-label="Upload progress" className="space-y-1.5">
            {rows.map((row, index) => (
              <li key={`${row.name}-${index}`} className="flex items-start gap-2.5 text-sm">
                <span aria-hidden="true" className="mt-0.5 size-4 shrink-0">
                  {row.state === "uploading" ? (
                    <LoadingIcon className="size-4 motion-safe:animate-spin" />
                  ) : row.state === "ready" ? (
                    <CheckIcon className="size-4 text-brand" />
                  ) : row.state === "failed" ? (
                    <span className="text-destructive">!</span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{row.name}</span>
                  {row.detail ? (
                    <span
                      className={cn(
                        "block text-xs",
                        row.state === "failed" ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {row.detail}
                    </span>
                  ) : null}
                </span>
                <span className="sr-only">
                  {row.state === "ready" ? "added" : row.state}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {teachHref && !busy ? (
          <Button
            type="button"
            onClick={() => {
              onOpenChange(false)
              router.push(teachHref)
            }}
            className="min-h-11 w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/85"
          >
            Start learning
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
