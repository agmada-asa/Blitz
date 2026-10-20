"use client"

/**
 * Collects and reviews answers to the quiz formats that are not multiple
 * choice: ordering (move rows up or down, or drag them), matching (one picker
 * per item), cloze (one field per numbered blank), and code output (a
 * monospace box for the program's output).
 *
 * Shared by inline quizzes (`QuizBlockView`) and Review feed cards, which only
 * learn the answer key from the server after answering. The value is always a
 * list of strings: option ids in order, the matched option id per item, the
 * text of each blank, or the typed output.
 */
import { useRef, useState, type DragEvent } from "react"

import { Button } from "@/components/ui/button"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CancelIcon,
  CheckCircleIcon,
  DragHandleIcon,
} from "@/components/ui/icon"
import { Input } from "@/components/ui/input"
import {
  answerCueClass,
  type AnswerCue,
} from "@/components/ui/interactive-blocks/answer-feedback"
import type { MarkdownRenderer } from "@/components/ui/interactive-blocks/context"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { StructuredAnswerShape } from "@/lib/interactive-blocks"
import { normalizeBlankAnswer } from "@/lib/learning/core"
import { cn } from "@/lib/utils"

/** The answer key, shown once the question has been answered. */
export type StructuredAnswerKey = {
  /** Ordering: ids in the correct order. Matching: the match per item. */
  correctOptionIds?: readonly string[]
  /** Cloze: accepted answers per blank. Code output: one entry of accepted outputs. */
  acceptedAnswers?: readonly (readonly string[])[]
}

/** Visible instruction under the question for each structured format. */
export const structuredHints: Record<
  "cloze" | "ordering" | "matching" | "code-output",
  string
> = {
  cloze: "Fill in the blanks.",
  ordering: "Put these in order, first at the top.",
  matching: "Match each item.",
  "code-output": "Type exactly what the program prints.",
}

/** Props shared by every structured answer input. */
type StructuredAnswerProps = {
  shape: StructuredAnswerShape
  value: string[]
  onChange: (value: string[]) => void
  /** Locks the input while checking and after answering. */
  disabled: boolean
  /** Present once answered; marks each row and shows what was expected. */
  answerKey?: StructuredAnswerKey
  /** Whether the whole answer was correct; only meaningful with `answerKey`. */
  correct?: boolean
  /** Plays the answer cue once; pass it only on the render where the answer was just checked. */
  cue?: AnswerCue
  renderMarkdown: MarkdownRenderer
  /** Unique prefix for element ids. */
  idBase: string
}

/**
 * Renders the input for one structured question, wrapped so a checked answer can
 * play its feedback cue on the whole answer.
 * @returns The ordering list, matching pickers, blank fields, or output box.
 */
export function StructuredAnswer(props: StructuredAnswerProps) {
  return (
    <div className={answerCueClass(props.cue)}>
      {props.shape.type === "ordering" ? (
        <OrderingAnswer {...props} />
      ) : props.shape.type === "matching" ? (
        <MatchingAnswer {...props} />
      ) : props.shape.type === "cloze" ? (
        <ClozeAnswer {...props} />
      ) : (
        <OutputAnswer {...props} />
      )}
    </div>
  )
}

/** A small correct or incorrect mark with visible text, so it never relies on colour. */
function RowMark({ correct, label }: { correct: boolean; label?: string }) {
  const Icon = correct ? CheckCircleIcon : CancelIcon
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs font-medium",
        correct ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"
      )}
    >
      <Icon size={15} aria-hidden="true" />
      {label ?? (correct ? "Correct" : "Incorrect")}
    </span>
  )
}

/** Row styling shared by ordering and matching; answered rows get a tinted border. */
function rowClass(mark: boolean | undefined) {
  return cn(
    "flex min-h-11 w-full items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 text-sm leading-5",
    mark === true && "border-emerald-500/45 bg-emerald-500/[0.06]",
    mark === false && "border-destructive/45 bg-destructive/[0.06]"
  )
}

/**
 * Ordering: a numbered list the learner rearranges with Move up and Move down
 * buttons (keyboard and touch) or by dragging rows with a mouse. Focus stays
 * on the moved item's button so repeated moves work from the keyboard.
 */
function OrderingAnswer({
  shape,
  value,
  onChange,
  disabled,
  answerKey,
  renderMarkdown,
  idBase,
}: StructuredAnswerProps) {
  const listRef = useRef<HTMLOListElement>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const byId = new Map(shape.options.map((option) => [option.id, option]))
  const correctOrder = answerKey?.correctOptionIds

  /**
   * Moves one item to a new position and keeps focus on its control.
   * @param from Current index.
   * @param to Target index, clamped to the list.
   * @param focus Which button to focus afterwards, when moved by keyboard.
   */
  function move(from: number, to: number, focus?: "up" | "down") {
    const target = Math.max(0, Math.min(value.length - 1, to))
    if (disabled || target === from) return
    const next = [...value]
    const [item] = next.splice(from, 1)
    next.splice(target, 0, item)
    onChange(next)
    if (!focus) return
    window.requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-order-id="${item}"]`
      )
      const preferred = row?.querySelector<HTMLButtonElement>(
        `[data-move="${focus}"]:not(:disabled)`
      )
      ;(
        preferred ??
        row?.querySelector<HTMLButtonElement>("[data-move]:not(:disabled)")
      )?.focus()
    })
  }

  /** Drops the dragged row onto another row's position. */
  function drop(event: DragEvent<HTMLLIElement>, index: number) {
    event.preventDefault()
    if (dragging) move(value.indexOf(dragging), index)
    setDragging(null)
  }

  return (
    <div className="space-y-3">
      <ol ref={listRef} className="grid gap-2" aria-label="Your order">
        {value.map((id, index) => {
          const option = byId.get(id)
          if (!option) return null
          const mark = correctOrder ? correctOrder[index] === id : undefined
          const textId = `${idBase}-order-${id}`
          return (
            <li
              key={id}
              data-order-id={id}
              draggable={!disabled}
              onDragStart={(event) => {
                setDragging(id)
                event.dataTransfer.effectAllowed = "move"
              }}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging) event.preventDefault()
              }}
              onDrop={(event) => drop(event, index)}
              className={cn(
                rowClass(mark),
                !disabled && "cursor-grab active:cursor-grabbing",
                dragging === id && "opacity-50"
              )}
            >
              {!disabled ? (
                <DragHandleIcon
                  size={16}
                  className="hidden shrink-0 text-muted-foreground sm:block"
                  aria-hidden="true"
                />
              ) : null}
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs text-muted-foreground tabular-nums"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <span id={textId} className="min-w-0 flex-1">
                {renderMarkdown(option.text, { inline: true })}
              </span>
              {mark !== undefined ? (
                <RowMark correct={mark} />
              ) : (
                <span className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-8"
                    data-move="up"
                    disabled={disabled || index === 0}
                    aria-label={`Move up, position ${index + 1}`}
                    aria-describedby={textId}
                    onClick={() => move(index, index - 1, "up")}
                  >
                    <ArrowUpIcon aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-8"
                    data-move="down"
                    disabled={disabled || index === value.length - 1}
                    aria-label={`Move down, position ${index + 1}`}
                    aria-describedby={textId}
                    onClick={() => move(index, index + 1, "down")}
                  >
                    <ArrowDownIcon aria-hidden="true" />
                  </Button>
                </span>
              )}
            </li>
          )
        })}
      </ol>
      {correctOrder && value.some((id, index) => correctOrder[index] !== id) ? (
        <div className="text-sm">
          <p className="font-medium">Correct order</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground">
            {correctOrder.map((id) => (
              <li key={id}>
                {renderMarkdown(byId.get(id)?.text ?? "", { inline: true })}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Matching: each left-hand item has a picker listing every possible match.
 * Once answered, wrong rows show the expected match.
 */
function MatchingAnswer({
  shape,
  value,
  onChange,
  disabled,
  answerKey,
  renderMarkdown,
  idBase,
}: StructuredAnswerProps) {
  const prompts = shape.prompts ?? []
  const byId = new Map(shape.options.map((option) => [option.id, option]))
  return (
    <div className="grid gap-2">
      {prompts.map((prompt, index) => {
        const expected = answerKey?.correctOptionIds?.[index]
        const mark =
          expected === undefined ? undefined : value[index] === expected
        const labelId = `${idBase}-match-${index}`
        return (
          <div
            key={prompt}
            className={cn(
              rowClass(mark),
              // A grid keeps the item readable when feedback adds a second line.
              "grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
            )}
          >
            <span id={labelId} className="min-w-0 font-medium break-words">
              {renderMarkdown(prompt, { inline: true })}
            </span>
            <Select
              // An empty string keeps the picker controlled while it shows the placeholder.
              value={value[index] ?? ""}
              disabled={disabled}
              onValueChange={(choice) => {
                const next = [...value]
                next[index] = choice
                onChange(next)
              }}
            >
              <SelectTrigger
                className="h-11 w-full min-w-0 sm:h-9"
                aria-labelledby={labelId}
              >
                <SelectValue placeholder="Choose a match" />
              </SelectTrigger>
              <SelectContent>
                {shape.options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {mark !== undefined ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:col-span-2">
                <RowMark correct={mark} />
                {mark === false && expected ? (
                  <span>
                    Matches{" "}
                    {renderMarkdown(byId.get(expected)?.text ?? "", {
                      inline: true,
                    })}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Cloze: one labelled field per numbered blank, in blank order. Once
 * answered, each blank is marked and wrong ones list the accepted answers.
 */
function ClozeAnswer({
  value,
  onChange,
  disabled,
  answerKey,
  idBase,
}: StructuredAnswerProps) {
  const single = value.length === 1
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {value.map((entry, index) => {
        const accepted = answerKey?.acceptedAnswers?.[index]
        const mark = accepted
          ? accepted
              .map(normalizeBlankAnswer)
              .includes(normalizeBlankAnswer(entry))
          : undefined
        const inputId = `${idBase}-blank-${index}`
        return (
          <div key={index} className="grid gap-1">
            <span className="flex items-center justify-between gap-2">
              <label
                htmlFor={inputId}
                className="text-xs font-medium text-muted-foreground"
              >
                {single ? "Your answer" : `Blank ${index + 1}`}
              </label>
              {mark !== undefined ? <RowMark correct={mark} /> : null}
            </span>
            <Input
              id={inputId}
              value={entry}
              disabled={disabled}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={cn(
                "h-11 font-mono sm:h-9",
                mark === true && "border-emerald-500/45",
                mark === false && "border-destructive/45"
              )}
              onChange={(event) => {
                const next = [...value]
                next[index] = event.target.value
                onChange(next)
              }}
            />
            {accepted && mark === false ? (
              <p className="text-xs text-muted-foreground">
                {accepted.length > 1 ? "Accepted answers" : "Answer"}:{" "}
                {accepted.join(", ")}
              </p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Code output: a monospace box; once answered, wrong answers show the expected output. */
function OutputAnswer({
  value,
  onChange,
  disabled,
  answerKey,
  correct,
  idBase,
}: StructuredAnswerProps) {
  const expected = answerKey?.acceptedAnswers?.[0]?.[0]
  const inputId = `${idBase}-output`
  return (
    <div className="grid gap-2">
      <label
        htmlFor={inputId}
        className="text-xs font-medium text-muted-foreground"
      >
        Output
      </label>
      <Textarea
        id={inputId}
        value={value[0] ?? ""}
        disabled={disabled}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        className="font-mono"
        onChange={(event) => onChange([event.target.value])}
      />
      {expected !== undefined && correct === false ? (
        <div className="text-sm">
          <p className="font-medium">Expected output</p>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs">
            {expected}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
