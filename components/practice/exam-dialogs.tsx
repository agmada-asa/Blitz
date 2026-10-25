"use client"

/**
 * The two ways to create an exam paper from the Practice screen: adding a
 * past paper (with optional solutions or mark scheme), and writing a mock
 * exam from chosen units. Both start background work and close as soon as
 * it has started; the Exam prep list follows the paper's progress.
 */

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LoadingIcon } from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { MAX_MOCK_GUIDANCE_CHARS, MOCK_EXAM_MINUTES } from "@/lib/exam-scoring"

/** File types accepted for a paper or its solutions, matching what the upload route can read. */
const PAPER_ACCEPT = ".pdf,.txt,.md,.markdown"

/** Reads a JSON `error` from a failed response, with a fallback. */
async function responseError(response: Response | null, fallback: string): Promise<string> {
  const payload = (await response?.json().catch(() => null)) as { error?: unknown } | null
  return typeof payload?.error === "string" ? payload.error : fallback
}

/**
 * Uploads one file as a module source with no unit, so it is stored and
 * read like any source but never taught. A PDF with no text layer, such as a
 * scan, is kept: question writing reads it from its pages where the chosen
 * provider can.
 * @returns The source ID.
 * @throws With a learner-facing message when the upload fails, or when a
 *   file other than a PDF has no readable text.
 */
async function uploadPaperFile(projectId: string, file: File): Promise<string> {
  const response = await fetch("/api/sources/upload", {
    method: "POST",
    headers: {
      "x-blitz-project-id": projectId,
      "x-blitz-filename": encodeURIComponent(file.name),
      ...(file.type ? { "content-type": file.type } : {}),
    },
    body: file,
  }).catch(() => null)
  if (!response?.ok)
    throw new Error(await responseError(response, `${file.name} could not be uploaded. Try again.`))
  const result = (await response.json().catch(() => null)) as {
    sourceId?: unknown
    unsupported?: unknown
  } | null
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  if (result?.unsupported && !isPdf)
    throw new Error(`${file.name} could not be read. Upload a PDF or a text file.`)
  if (typeof result?.sourceId !== "string")
    throw new Error(`${file.name} could not be uploaded. Try again.`)
  return result.sourceId
}

/** Dialog that uploads a past paper and starts reading its questions. */
export function AddPastPaperDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [paper, setPaper] = useState<File | null>(null)
  const [solutions, setSolutions] = useState<File | null>(null)
  const [step, setStep] = useState("")
  const [error, setError] = useState("")
  const busy = Boolean(step)

  /** Resets the form when the dialog closes, unless an upload is running. */
  function changeOpen(next: boolean) {
    if (busy) return
    if (!next) {
      setPaper(null)
      setSolutions(null)
      setError("")
    }
    onOpenChange(next)
  }

  /** Uploads the files, records the paper, and closes once reading has started. */
  async function addPaper() {
    if (!paper || busy) return
    setError("")
    try {
      setStep("Uploading the paper…")
      const sourceId = await uploadPaperFile(projectId, paper)
      let solutionsSourceId: string | undefined
      if (solutions) {
        setStep("Uploading the solutions…")
        solutionsSourceId = await uploadPaperFile(projectId, solutions)
      }
      setStep("Starting…")
      const response = await fetch("/api/practice/exam/papers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, sourceId, solutionsSourceId }),
      }).catch(() => null)
      if (!response?.ok)
        throw new Error(await responseError(response, "The paper could not be added. Try again."))
      setStep("")
      setPaper(null)
      setSolutions(null)
      onOpenChange(false)
    } catch (caught) {
      setStep("")
      setError(caught instanceof Error ? caught.message : "The paper could not be added. Try again.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a past paper</DialogTitle>
          <DialogDescription>
            Blitz reads the questions so you can sit the paper against the clock and have it
            marked. Add the solutions or mark scheme too if you have them; otherwise answers
            are worked out for you.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="past-paper-file" className="text-sm font-medium">
              Paper
            </label>
            <Input
              id="past-paper-file"
              type="file"
              accept={PAPER_ACCEPT}
              disabled={busy}
              onChange={(event) => setPaper(event.target.files?.[0] ?? null)}
              className="min-h-11"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="past-paper-solutions" className="text-sm font-medium">
              Solutions or mark scheme <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="past-paper-solutions"
              type="file"
              accept={PAPER_ACCEPT}
              disabled={busy}
              onChange={(event) => setSolutions(event.target.files?.[0] ?? null)}
              className="min-h-11"
            />
          </div>
        </div>
        {step ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoadingIcon aria-hidden="true" className="size-4 motion-safe:animate-spin" />
            {step}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            disabled={!paper || busy}
            onClick={() => void addPaper()}
            className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
          >
            Add past paper
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Lets the learner pick how long a paper lasts, as a labelled group of radio
 * pills. Shared by the mock exam dialog and the start screen of a past paper
 * that states no time.
 * @param idPrefix Unique prefix for the group's element ids.
 * @param value Selected minutes, as a string.
 */
export function LengthChoice({
  idPrefix,
  options,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string
  options: readonly number[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const labelId = `${idPrefix}-label`
  return (
    <fieldset className="space-y-2">
      <legend id={labelId} className="text-sm font-medium">
        Length
      </legend>
      <RadioGroup
        value={value}
        onValueChange={onChange}
        className="flex flex-wrap gap-2"
        aria-labelledby={labelId}
      >
        {options.map((minutes) => {
          const id = `${idPrefix}-${minutes}`
          return (
            <label
              key={minutes}
              htmlFor={id}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm has-[[data-state=checked]]:border-brand has-[[data-state=checked]]:bg-brand/10"
            >
              <RadioGroupItem id={id} value={String(minutes)} disabled={disabled} />
              {minutes} minutes
            </label>
          )
        })}
      </RadioGroup>
    </fieldset>
  )
}

/** A unit the learner can include in a mock exam. */
export type MockUnitOption = { id: string; title: string }

/** Dialog that writes a mock exam from chosen units, length, and optional instructions. */
export function WriteMockExamDialog({
  projectId,
  units,
  open,
  onOpenChange,
}: {
  projectId: string
  /** Units that have readable material. */
  units: MockUnitOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Null means "every unit", so units added while the dialog is closed are included by default.
  const [chosen, setChosen] = useState<string[] | null>(null)
  const [minutes, setMinutes] = useState("60")
  const [guidance, setGuidance] = useState("")
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState("")
  const selected = chosen ?? units.map((unit) => unit.id)

  /** Resets the form when the dialog closes, unless a request is running. */
  function changeOpen(next: boolean) {
    if (starting) return
    if (!next) {
      setChosen(null)
      setGuidance("")
      setError("")
    }
    onOpenChange(next)
  }

  /** Adds or removes a unit from the selection. */
  function toggle(unitId: string, checked: boolean) {
    const next = checked ? [...selected, unitId] : selected.filter((id) => id !== unitId)
    setChosen(units.map((unit) => unit.id).filter((id) => next.includes(id)))
  }

  /** Starts writing the mock and closes once it has started. */
  async function writeMock() {
    if (!selected.length || starting) return
    setStarting(true)
    setError("")
    const response = await fetch("/api/practice/exam/mock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        unitIds: selected,
        minutes: Number(minutes),
        generationGuidance: guidance,
      }),
    }).catch(() => null)
    setStarting(false)
    if (!response?.ok) {
      setError(await responseError(response, "The mock exam could not be started. Try again."))
      return
    }
    setChosen(null)
    setGuidance("")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Write a mock exam</DialogTitle>
          <DialogDescription>
            A new timed paper from the units you choose, in the style of your past papers when you
            have added any. Concepts you keep missing get more questions.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Units</legend>
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {units.map((unit) => {
              const id = `mock-unit-${unit.id}`
              return (
                <li key={unit.id}>
                  <label
                    htmlFor={id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-muted"
                  >
                    <Checkbox
                      id={id}
                      checked={selected.includes(unit.id)}
                      disabled={starting}
                      onCheckedChange={(checked) => toggle(unit.id, checked === true)}
                    />
                    <span className="min-w-0 text-sm break-words">{unit.title}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        </fieldset>
        <LengthChoice
          idPrefix="mock-length"
          options={MOCK_EXAM_MINUTES}
          value={minutes}
          onChange={setMinutes}
          disabled={starting}
        />
        <div className="space-y-1.5">
          <label htmlFor="mock-guidance" className="text-sm font-medium">
            Instructions <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Textarea
            id="mock-guidance"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder="e.g. 5 multiple-choice questions and 1 essay"
            maxLength={MAX_MOCK_GUIDANCE_CHARS}
            disabled={starting}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            disabled={!selected.length || starting}
            onClick={() => void writeMock()}
            className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
          >
            {starting ? (
              <>
                <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Starting
              </>
            ) : (
              "Write mock exam"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
