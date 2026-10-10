"use client"

/**
 * The question editor for one exam paper, at `?edit=1` on the paper's page.
 * It lists every question with its answer, mark scheme, and concept, and
 * lets the learner fix what extraction or the mock writer got wrong: each
 * question opens in a dialog that saves through `POST
 * /api/practice/exam/questions`, and a single question can be deleted after
 * confirming. Editing is blocked while the paper is being prepared or an
 * attempt is being marked; earlier attempts are marked again on the server.
 */

import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { useId, useRef, useState } from "react"

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
import {
  ArrowLeftIcon,
  CancelIcon,
  CheckCircleIcon,
  LoadingIcon,
  PlusIcon,
} from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import { plainMarkdownRenderer } from "@/components/ui/markdown"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ExamQuestionEditInput } from "@/lib/exam"
import {
  EXAM_CHANGE_LOCK_MESSAGES,
  EXAM_LIMITS,
  EXAM_MARK_RANGE,
  type ExamQuestionType,
} from "@/lib/exam-scoring"
import { cn } from "@/lib/utils"

/** The editor's data for one paper. */
type EditorData = NonNullable<FunctionReturnType<typeof api.exam.editorSession>>

/** One question with its answer key, as the editor shows it. */
type EditorQuestion = EditorData["questions"][number]

/** An option being edited; `previousId` ties it to the saved option it came from. */
type OptionDraft = { key: string; text: string; previousId: string | null }

/** A mark scheme point being edited, with marks as typed. */
type PointDraft = { key: string; point: string; marks: string }

/** The edit dialog's form state. Numbers stay as typed until saving. */
type Draft = {
  number: string
  marks: string
  type: ExamQuestionType
  prompt: string
  concept: string
  options: OptionDraft[]
  /** Keys of the options marked correct. */
  correct: string[]
  answer: "true" | "false"
  explanation: string
  modelAnswer: string
  markScheme: PointDraft[]
}

/** Shared pill style for radio choices, matching the paper length choice. */
const pillClass =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm has-[[data-state=checked]]:border-brand has-[[data-state=checked]]:bg-brand/10"

/** Joins a count and a noun, adding "s" for anything but one. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** Returns the letter printed beside an option: A, B, C, … */
function letter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** Counter behind `draftKey`; only uniqueness within the page matters. */
let draftKeyCount = 0

/** Returns a key that identifies a draft row across re-renders, independent of its position. */
function draftKey(): string {
  draftKeyCount += 1
  return `row-${draftKeyCount}`
}

/** Builds the form state for a saved question. */
function draftFrom(question: EditorQuestion): Draft {
  const options =
    question.type === "true-false"
      ? []
      : question.options.map((option) => ({ key: draftKey(), text: option.text, previousId: option.id }))
  return {
    number: question.number,
    marks: String(question.marks),
    type: question.type,
    prompt: question.prompt,
    concept: question.concept,
    options,
    correct: options
      .filter((option) => option.previousId && question.correctOptionIds.includes(option.previousId))
      .map((option) => option.key),
    answer: question.correctOptionIds[0] === "false" ? "false" : "true",
    explanation: question.explanation,
    modelAnswer: question.modelAnswer,
    markScheme: question.markScheme.map((point) => ({
      key: draftKey(),
      point: point.point,
      marks: String(point.marks),
    })),
  }
}

/**
 * Converts form state into the edit the questions route validates. Blank
 * numbers become 0 and unreadable ones NaN (sent as null), which the server
 * rejects with a message saying what to fix.
 */
function toEdit(draft: Draft): ExamQuestionEditInput {
  const base = {
    number: draft.number,
    marks: Number(draft.marks),
    type: draft.type,
    prompt: draft.prompt,
    concept: draft.concept,
  }
  if (draft.type === "written")
    return {
      ...base,
      modelAnswer: draft.modelAnswer,
      markScheme: draft.markScheme.map((point) => ({ point: point.point, marks: Number(point.marks) })),
    }
  if (draft.type === "true-false")
    return { ...base, answer: draft.answer === "true", explanation: draft.explanation }
  return {
    ...base,
    options: draft.options.map((option) => ({ text: option.text, previousId: option.previousId })),
    correctIndices: draft.options.flatMap((option, index) =>
      draft.correct.includes(option.key) ? [index] : []
    ),
    explanation: draft.explanation,
  }
}

/** Renders the question editor for one paper. */
export function ExamEditor({ projectId, paperId }: { projectId: string; paperId: string }) {
  const editor = useQuery(api.exam.editorSession, { paperId: paperId as Id<"examPapers"> })
  const deleteQuestion = useMutation(api.exam.deleteQuestion)
  const [editing, setEditing] = useState<EditorQuestion | null>(null)
  // The question last chosen for deletion stays set while the dialog closes, so its title doesn't change mid-animation.
  const [removing, setRemoving] = useState<EditorQuestion | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [removePending, setRemovePending] = useState(false)
  const [removeError, setRemoveError] = useState("")
  const [notice, setNotice] = useState("")
  const headingRef = useRef<HTMLHeadingElement>(null)
  // Set when a question was deleted, so focus moves to the heading instead of its removed button.
  const focusHeadingRef = useRef(false)
  const practiceHref = `/projects/${encodeURIComponent(projectId)}/practice`
  const paperHref = `${practiceHref}/exam/${encodeURIComponent(paperId)}`

  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-9">
      <Link href={paperHref}>
        <ArrowLeftIcon aria-hidden="true" /> Back to paper
      </Link>
    </Button>
  )

  if (editor === undefined)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        {back}
        <div className="mt-8 space-y-3" aria-label="Loading questions">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      </main>
    )

  if (editor === null)
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <Button asChild variant="ghost" size="sm" className="-ml-2 min-h-9">
          <Link href={practiceHref}>
            <ArrowLeftIcon aria-hidden="true" /> Practice
          </Link>
        </Button>
        <h1 className="mt-8 font-heading text-2xl font-semibold">Paper not found</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been deleted. Your other papers are on the Practice screen.
        </p>
      </main>
    )

  const { paper, questions } = editor
  const lock = paper.changeLock

  /** Deletes the question being confirmed and announces the result. */
  async function confirmRemove() {
    if (!removing || !removeOpen || removePending) return
    setRemovePending(true)
    setRemoveError("")
    try {
      await deleteQuestion({ paperId: paper.id, questionId: removing.id })
      setNotice(`Question ${removing.number} deleted.`)
      focusHeadingRef.current = true
      setRemoveOpen(false)
    } catch (cause) {
      setRemoveError(
        cause instanceof ConvexError && typeof cause.data === "string"
          ? cause.data
          : "The question could not be deleted. Try again."
      )
    } finally {
      setRemovePending(false)
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
      {back}
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-6 font-heading text-3xl font-semibold tracking-tight outline-none sm:text-4xl"
      >
        Edit questions
      </h1>
      <p className="mt-2 text-sm break-words text-muted-foreground">{paper.title}</p>

      {lock ? (
        <p role="status" className="mt-4 rounded-xl border border-border bg-muted/50 p-4 text-sm">
          {EXAM_CHANGE_LOCK_MESSAGES[lock]}
        </p>
      ) : paper.status !== "ready" ? (
        <p className="mt-4 text-sm text-muted-foreground">
          This paper has no questions to edit. Try preparing it again from the Practice screen.
        </p>
      ) : (
        <div className="mt-4 space-y-1 text-sm text-muted-foreground">
          <p>Answers are shown here, so you may want to sit the paper first.</p>
          {paper.submittedAttemptCount ? (
            <p>
              Changing an answer marks your earlier attempts again. Written answers keep the marks
              they were given, up to the question&apos;s new marks.
            </p>
          ) : null}
        </div>
      )}

      <div role="status" aria-live="polite">
        {notice ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
            <CheckCircleIcon size={16} aria-hidden="true" /> {notice}
          </p>
        ) : null}
      </div>

      {questions.length ? (
        <ol className="mt-6 space-y-3">
          {questions.map((question) => (
            <li key={question.id}>
              <QuestionSummary
                question={question}
                disabled={Boolean(lock)}
                onEdit={() => {
                  setNotice("")
                  setEditing(question)
                }}
                onDelete={() => {
                  setNotice("")
                  setRemoveError("")
                  setRemoving(question)
                  setRemoveOpen(true)
                }}
              />
            </li>
          ))}
        </ol>
      ) : null}

      <Button
        asChild
        className="mt-8 min-h-11 w-full rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85 sm:w-auto"
      >
        <Link href={paperHref}>Done editing</Link>
      </Button>

      {editing ? (
        <QuestionEditDialog
          key={editing.id}
          paperId={paper.id}
          question={editing}
          onClose={() => setEditing(null)}
          onSaved={(number) => {
            setEditing(null)
            setNotice(`Question ${number} saved.`)
          }}
        />
      ) : null}

      <Dialog
        open={removeOpen}
        onOpenChange={(next) => {
          if (!next && !removePending) setRemoveOpen(false)
        }}
      >
        <DialogContent
          showCloseButton={!removePending}
          onCloseAutoFocus={(event) => {
            if (!focusHeadingRef.current) return
            focusHeadingRef.current = false
            event.preventDefault()
            headingRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Delete question {removing?.number}?</DialogTitle>
            <DialogDescription>
              {questions.length > 1
                ? "It's removed from the paper, and earlier attempts lose its marks. This can't be undone."
                : "A paper needs at least one question. To remove it, delete the paper from its menu instead."}
            </DialogDescription>
          </DialogHeader>
          {removeError ? (
            <p role="alert" className="text-sm text-destructive">
              {removeError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              autoFocus
              disabled={removePending}
              onClick={() => setRemoveOpen(false)}
              className="min-h-11 rounded-full px-5"
            >
              {questions.length > 1 ? "Keep question" : "Close"}
            </Button>
            {questions.length > 1 ? (
              <Button
                type="button"
                variant="destructive"
                disabled={removePending}
                onClick={() => void confirmRemove()}
                className="min-h-11 rounded-full px-5"
              >
                {removePending ? (
                  <>
                    <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Deleting
                  </>
                ) : (
                  "Delete question"
                )}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

/** Shows one question with its answer and the buttons to edit or delete it. */
function QuestionSummary({
  question,
  disabled,
  onEdit,
  onDelete,
}: {
  question: EditorQuestion
  /** True while the paper is locked against changes. */
  disabled: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const headingId = `edit-${question.id}`
  return (
    <article aria-labelledby={headingId} className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="min-w-0 text-sm font-semibold break-words">
          Question {question.number}
          <span className="ml-2 font-normal text-muted-foreground">{question.concept}</span>
        </h2>
        <span className="shrink-0 text-xs text-muted-foreground">{plural(question.marks, "mark")}</span>
      </div>
      <div className="mt-2 min-w-0 text-sm">{plainMarkdownRenderer(question.prompt)}</div>

      {question.type === "written" ? (
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">Model answer</h3>
            <div className="mt-1 min-w-0">{plainMarkdownRenderer(question.modelAnswer)}</div>
          </div>
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">Mark scheme</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {question.markScheme.map((point, index) => (
                <li key={index} className="break-words">
                  {point.point}{" "}
                  <span className="text-muted-foreground">({plural(point.marks, "mark")})</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <>
          <ul className="mt-3 grid gap-2">
            {question.options.map((option, index) => {
              const correct = question.correctOptionIds.includes(option.id)
              return (
                <li
                  key={option.id}
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-sm",
                    correct && "border-emerald-500/45 bg-emerald-500/[0.06]"
                  )}
                >
                  {question.type !== "true-false" ? (
                    <span aria-hidden="true" className="text-xs text-muted-foreground">
                      {letter(index)}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 break-words">
                    {plainMarkdownRenderer(option.text, { inline: true })}
                  </span>
                  {correct ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                      <CheckCircleIcon size={14} aria-hidden="true" /> Correct
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
          {question.explanation ? (
            <div className="mt-3 min-w-0 text-sm text-muted-foreground">
              {plainMarkdownRenderer(question.explanation)}
            </div>
          ) : null}
        </>
      )}

      {question.answerSource === "inferred" ? (
        <p className="mt-3 text-xs text-muted-foreground">
          This answer was worked out without solutions. Correct it if it&apos;s wrong.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={onEdit}
          aria-label={`Edit question ${question.number}`}
          className="min-h-10 rounded-full px-4"
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={onDelete}
          aria-label={`Delete question ${question.number}`}
          className="min-h-10 rounded-full px-4 text-destructive hover:text-destructive"
        >
          Delete
        </Button>
      </div>
    </article>
  )
}

/**
 * Dialog that edits one question and saves it through the questions route.
 * It stays open with the server's message when the edit is refused.
 * @param onSaved Called with the saved question's number.
 */
function QuestionEditDialog({
  paperId,
  question,
  onClose,
  onSaved,
}: {
  paperId: Id<"examPapers">
  question: EditorQuestion
  onClose: () => void
  onSaved: (number: string) => void
}) {
  const [draft, setDraft] = useState(() => draftFrom(question))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const id = useId()
  const isOptionList = draft.type === "single-choice" || draft.type === "multiple-answer"
  const schemeTotal = draft.markScheme.reduce((sum, point) => sum + (Number(point.marks) || 0), 0)

  /** Merges changed fields into the draft. */
  function update(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }))
  }

  /** Updates one option's text. */
  function setOptionText(key: string, text: string) {
    setDraft((current) => ({
      ...current,
      options: current.options.map((option) => (option.key === key ? { ...option, text } : option)),
    }))
  }

  /** Removes an option and any correct mark on it. */
  function removeOption(key: string) {
    setDraft((current) => ({
      ...current,
      options: current.options.filter((option) => option.key !== key),
      correct: current.correct.filter((entry) => entry !== key),
    }))
  }

  /** Marks or unmarks an option as correct in a multiple-answer question. */
  function toggleCorrect(key: string, checked: boolean) {
    setDraft((current) => ({
      ...current,
      correct: checked
        ? [...current.correct.filter((entry) => entry !== key), key]
        : current.correct.filter((entry) => entry !== key),
    }))
  }

  /** Switches between one and several correct options, keeping one mark when narrowing. */
  function setFormat(type: string) {
    if (type !== "single-choice" && type !== "multiple-answer") return
    setDraft((current) => ({
      ...current,
      type,
      correct: type === "single-choice" ? current.correct.slice(0, 1) : current.correct,
    }))
  }

  /** Updates one mark scheme point. */
  function setPoint(key: string, patch: Partial<PointDraft>) {
    setDraft((current) => ({
      ...current,
      markScheme: current.markScheme.map((point) => (point.key === key ? { ...point, ...patch } : point)),
    }))
  }

  /** Sends the edit; closes on success and shows the server's reason otherwise. */
  async function save() {
    if (saving) return
    setSaving(true)
    setError("")
    const response = await fetch("/api/practice/exam/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperId, questionId: question.id, question: toEdit(draft) }),
    }).catch(() => null)
    const payload = (await response?.json().catch(() => null)) as { error?: unknown } | null
    setSaving(false)
    if (!response?.ok) {
      setError(
        typeof payload?.error === "string" ? payload.error : "The question could not be saved. Try again."
      )
      return
    }
    onSaved(draft.number.trim() || question.number)
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose()
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Edit question {question.number}</DialogTitle>
          <DialogDescription>
            {question.answerSource === "inferred"
              ? "This answer was worked out without solutions. Correct anything that's wrong."
              : "Correct the wording, answer, or marks."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-number`} className="text-sm font-medium">
                Number
              </label>
              <Input
                id={`${id}-number`}
                value={draft.number}
                maxLength={EXAM_LIMITS.numberChars}
                onChange={(event) => update({ number: event.target.value })}
                className="min-h-11"
              />
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-marks`} className="text-sm font-medium">
                Marks
              </label>
              <Input
                id={`${id}-marks`}
                type="number"
                inputMode="decimal"
                min={EXAM_MARK_RANGE.min}
                max={EXAM_MARK_RANGE.max}
                step={0.5}
                value={draft.marks}
                onChange={(event) => update({ marks: event.target.value })}
                className="min-h-11"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${id}-concept`} className="text-sm font-medium">
              Concept
            </label>
            <Input
              id={`${id}-concept`}
              value={draft.concept}
              maxLength={EXAM_LIMITS.conceptChars}
              aria-describedby={`${id}-concept-hint`}
              onChange={(event) => update({ concept: event.target.value })}
              className="min-h-11"
            />
            <p id={`${id}-concept-hint`} className="text-xs text-muted-foreground">
              The idea the question tests. Results group questions by concept.
            </p>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor={`${id}-prompt`} className="text-sm font-medium">
              Question
            </label>
            <Textarea
              id={`${id}-prompt`}
              value={draft.prompt}
              maxLength={EXAM_LIMITS.promptChars}
              aria-describedby={`${id}-prompt-hint`}
              onChange={(event) => update({ prompt: event.target.value })}
              className="min-h-32"
            />
            <p id={`${id}-prompt-hint`} className="text-xs text-muted-foreground">
              Markdown, with code blocks and LaTeX.
            </p>
          </div>

          {isOptionList ? (
            <>
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium">Correct answers</legend>
                <RadioGroup
                  value={draft.type}
                  onValueChange={setFormat}
                  className="flex flex-wrap gap-2"
                >
                  <label htmlFor={`${id}-single`} className={pillClass}>
                    <RadioGroupItem id={`${id}-single`} value="single-choice" />
                    One
                  </label>
                  <label htmlFor={`${id}-multiple`} className={pillClass}>
                    <RadioGroupItem id={`${id}-multiple`} value="multiple-answer" />
                    More than one
                  </label>
                </RadioGroup>
              </fieldset>
              <OptionsEditor
                idPrefix={id}
                draft={draft}
                onText={setOptionText}
                onRemove={removeOption}
                onChooseOne={(key) => update({ correct: [key] })}
                onToggle={toggleCorrect}
                onAdd={() =>
                  update({
                    options: [...draft.options, { key: draftKey(), text: "", previousId: null }],
                  })
                }
              />
            </>
          ) : null}

          {draft.type === "true-false" ? (
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Answer</legend>
              <RadioGroup
                value={draft.answer}
                onValueChange={(value) => update({ answer: value === "false" ? "false" : "true" })}
                className="flex flex-wrap gap-2"
              >
                <label htmlFor={`${id}-true`} className={pillClass}>
                  <RadioGroupItem id={`${id}-true`} value="true" />
                  True
                </label>
                <label htmlFor={`${id}-false`} className={pillClass}>
                  <RadioGroupItem id={`${id}-false`} value="false" />
                  False
                </label>
              </RadioGroup>
            </fieldset>
          ) : null}

          {draft.type !== "written" ? (
            <div className="grid gap-1.5">
              <label htmlFor={`${id}-explanation`} className="text-sm font-medium">
                Explanation
              </label>
              <Textarea
                id={`${id}-explanation`}
                value={draft.explanation}
                maxLength={EXAM_LIMITS.explanationChars}
                aria-describedby={`${id}-explanation-hint`}
                onChange={(event) => update({ explanation: event.target.value })}
                className="min-h-24"
              />
              <p id={`${id}-explanation-hint`} className="text-xs text-muted-foreground">
                Shown with your results: why the answer is right.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <label htmlFor={`${id}-model`} className="text-sm font-medium">
                  Model answer
                </label>
                <Textarea
                  id={`${id}-model`}
                  value={draft.modelAnswer}
                  maxLength={EXAM_LIMITS.modelAnswerChars}
                  onChange={(event) => update({ modelAnswer: event.target.value })}
                  className="min-h-32"
                />
              </div>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">Mark scheme</legend>
                <p id={`${id}-scheme-hint`} className="text-xs text-muted-foreground tabular-nums">
                  Points add up to {plural(schemeTotal, "mark")}
                  {draft.marks ? ` of the question's ${draft.marks}` : ""}.
                </p>
                <ol className="grid gap-2">
                  {draft.markScheme.map((point, index) => (
                    <li key={point.key} className="flex items-start gap-2">
                      <Input
                        aria-label={`Point ${index + 1}`}
                        value={point.point}
                        maxLength={EXAM_LIMITS.markPointChars}
                        onChange={(event) => setPoint(point.key, { point: event.target.value })}
                        className="min-h-11 min-w-0 flex-1"
                      />
                      <Input
                        aria-label={`Marks for point ${index + 1}`}
                        type="number"
                        inputMode="decimal"
                        min={EXAM_MARK_RANGE.min}
                        max={EXAM_MARK_RANGE.max}
                        step={0.5}
                        value={point.marks}
                        onChange={(event) => setPoint(point.key, { marks: event.target.value })}
                        className="min-h-11 w-20 shrink-0"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={draft.markScheme.length <= 1}
                        onClick={() =>
                          update({
                            markScheme: draft.markScheme.filter((entry) => entry.key !== point.key),
                          })
                        }
                        aria-label={`Remove point ${index + 1}`}
                        className="size-11 shrink-0 rounded-full text-muted-foreground"
                      >
                        <CancelIcon aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ol>
                <Button
                  type="button"
                  variant="outline"
                  disabled={draft.markScheme.length >= EXAM_LIMITS.maxMarkPoints}
                  onClick={() =>
                    update({ markScheme: [...draft.markScheme, { key: draftKey(), point: "", marks: "1" }] })
                  }
                  className="min-h-10 w-fit rounded-full px-4"
                >
                  <PlusIcon aria-hidden="true" /> Add point
                </Button>
              </fieldset>
            </>
          )}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
              className="min-h-11 rounded-full px-5"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="min-h-11 rounded-full bg-brand px-6 text-brand-foreground hover:bg-brand/85"
            >
              {saving ? (
                <>
                  <LoadingIcon aria-hidden="true" className="motion-safe:animate-spin" /> Saving
                </>
              ) : (
                "Save question"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Edits a choice question's options and marks the correct ones: a radio per
 * option for one correct answer, a checkbox per option for several.
 */
function OptionsEditor({
  idPrefix,
  draft,
  onText,
  onRemove,
  onChooseOne,
  onToggle,
  onAdd,
}: {
  idPrefix: string
  draft: Draft
  onText: (key: string, text: string) => void
  onRemove: (key: string) => void
  onChooseOne: (key: string) => void
  onToggle: (key: string, checked: boolean) => void
  onAdd: () => void
}) {
  const single = draft.type === "single-choice"
  const hintId = `${idPrefix}-options-hint`

  const rows = draft.options.map((option, index) => (
    <div key={option.key} className="flex items-center gap-2">
      <span className="flex size-11 shrink-0 items-center justify-center">
        {single ? (
          <RadioGroupItem value={option.key} aria-label={`Option ${letter(index)} is correct`} />
        ) : (
          <Checkbox
            checked={draft.correct.includes(option.key)}
            onCheckedChange={(checked) => onToggle(option.key, checked === true)}
            aria-label={`Option ${letter(index)} is correct`}
          />
        )}
      </span>
      <Input
        aria-label={`Option ${letter(index)}`}
        value={option.text}
        maxLength={EXAM_LIMITS.optionChars}
        onChange={(event) => onText(option.key, event.target.value)}
        className="min-h-11 min-w-0 flex-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={draft.options.length <= 2}
        onClick={() => onRemove(option.key)}
        aria-label={`Remove option ${letter(index)}`}
        className="size-11 shrink-0 rounded-full text-muted-foreground"
      >
        <CancelIcon aria-hidden="true" />
      </Button>
    </div>
  ))

  return (
    <fieldset className="grid gap-2" aria-describedby={hintId}>
      <legend className="mb-1 text-sm font-medium">Options</legend>
      <p id={hintId} className="text-xs text-muted-foreground">
        {single ? "Mark the correct option." : "Mark every correct option, and leave at least one incorrect."}
      </p>
      {single ? (
        <RadioGroup
          value={draft.correct[0] ?? ""}
          onValueChange={onChooseOne}
          aria-label="Correct option"
          className="grid gap-2"
        >
          {rows}
        </RadioGroup>
      ) : (
        <div className="grid gap-2">{rows}</div>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={draft.options.length >= EXAM_LIMITS.maxOptions}
        onClick={onAdd}
        className="min-h-10 w-fit rounded-full px-4"
      >
        <PlusIcon aria-hidden="true" /> Add option
      </Button>
    </fieldset>
  )
}
