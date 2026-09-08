"use client"

/** Renders one source-backed walkthrough step with inline question scoring. */

import Link from "next/link"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  AiSearch01Icon,
  ArrowDownIcon,
  CheckIcon,
  HelpIcon,
  Refresh04Icon,
  SparklesIcon,
  ZapIcon,
} from "@/components/ui/icon"
import { Markdown } from "@/components/ui/markdown"
import type {
  AnswerRequest,
  AnswerResponse,
  FeedOption,
  LearningAnswer,
} from "@/lib/learning/client-contracts"
import { cn } from "@/lib/utils"

/** One answer-safe learning item displayed in a project walkthrough. */
export type WalkthroughItem = {
  id: string
  conceptId: string
  type: "explain" | "single-choice" | "multiple-answer" | "true-false"
  title: string
  body?: string
  /** Source-grounded longer lesson shown on an explanation card's back face. */
  deepExplanation?: string
  question?: string
  options?: FeedOption[]
  sourceLabels: string[]
}

/** Props that connect a walkthrough card to navigation and server scoring. */
type WalkthroughCardProps = {
  item: WalkthroughItem
  projectId: string
  conceptTitle: string
  position: number
  total: number
  onNext?: () => void
}

/** Returns a stable event identifier for one browser answer submission. */
function createClientEventId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads a bounded route error when answer scoring fails. */
async function readAnswerError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown }
    if (typeof payload.error === "string") return payload.error
  } catch {
    // The fixed fallback keeps malformed server responses out of the interface.
  }
  return "Could not check that answer."
}

/** Sends one answer to the existing server-owned scoring boundary. */
async function submitWalkthroughAnswer(
  projectId: string,
  itemId: string,
  answer: LearningAnswer
): Promise<AnswerResponse> {
  const request: AnswerRequest = {
    projectId,
    itemId,
    clientEventId: createClientEventId(),
    occurredAt: Date.now(),
    answer,
  }
  const response = await fetch("/api/learning/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await readAnswerError(response))
  return (await response.json()) as AnswerResponse
}

/** Builds the visible choices for stored and true-or-false questions. */
function optionsForItem(item: WalkthroughItem): FeedOption[] {
  if (item.type === "true-false") {
    return [
      { id: "true", text: "True" },
      { id: "false", text: "False" },
    ]
  }
  return item.options ?? []
}

/** Converts one displayed choice into the answer expected by the learning API. */
function answerForOption(
  item: WalkthroughItem,
  optionId: string
): LearningAnswer {
  return item.type === "true-false" ? optionId === "true" : optionId
}

/** Shared card surface styles applied to each visible face. */
const cardFaceClass =
  "w-full rounded-[28px] border border-border/70 bg-card px-5 py-6 shadow-sm transition-[max-height] duration-300 sm:px-8 sm:py-8 lg:px-10 lg:py-10"

/** Builds the focused first prompt for a card-backed, source-grounded deep dive. */
function buildDeepDivePrompt(conceptTitle: string, itemTitle: string): string {
  return `Give me a deeper explanation of "${itemTitle}" within "${conceptTitle}". Use the attached card and source material. Explain the underlying idea, why it matters, how it works, one concrete example, and any common misconception the source supports. Connect it to other relevant topics in this project when that connection is useful, and distinguish source-backed claims from reasonable inferences. Keep the answer focused and cite the source material.`
}

/** Checks whether an explanation card has enough detail to offer an expansion toggle. */
function hasExpandableExplanation(
  deepExplanation?: string,
  body?: string
): boolean {
  if (!deepExplanation?.trim()) return false
  const trimmedDeep = deepExplanation.trim()
  const trimmedBody = body?.trim() ?? ""
  return trimmedDeep !== trimmedBody && trimmedDeep.length > 120
}

/** Renders one explanation or inline check inside the walkthrough stage. */
export function WalkthroughCard({
  item,
  projectId,
  conceptTitle,
  position,
  total,
  onNext,
}: WalkthroughCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedMany, setSelectedMany] = useState<string[]>([])
  const [feedback, setFeedback] = useState<AnswerResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [flipped, setFlipped] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isExplanation = item.type === "explain"
  const isMultipleAnswer = item.type === "multiple-answer"
  const isExpandable =
    isExplanation &&
    hasExpandableExplanation(item.deepExplanation, item.body)

  const [prevItemId, setPrevItemId] = useState(item.id)
  if (prevItemId !== item.id) {
    setPrevItemId(item.id)
    setFlipped(false)
    setExpanded(false)
  }

  /** Flips back to the front face and collapses any expanded explanation. */
  function handleFlipToFront(): void {
    setFlipped(false)
    setExpanded(false)
  }

  /** Advances to the next card while resetting face flipping and expansion. */
  function handleNext(): void {
    setFlipped(false)
    setExpanded(false)
    onNext?.()
  }

  /** Checks whether the server identified one visible option as correct. */
  function optionIsCorrect(optionId: string): boolean {
    if (!feedback?.feedback) return false
    if (item.type === "true-false") {
      return feedback.feedback.correctAnswer === (optionId === "true")
    }
    if (item.type === "single-choice") {
      return feedback.feedback.correctOptionId === optionId
    }
    return feedback.feedback.correctOptionIds?.includes(optionId) ?? false
  }

  /** Returns the selected, correct, or incorrect treatment for one choice. */
  function optionClass(optionId: string, isSelected: boolean): string {
    return cn(
      "flex min-h-14 w-full items-center gap-3 rounded-2xl border bg-background/70 px-4 text-left text-sm transition-[border-color,background-color,transform] hover:border-foreground/20 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:scale-[0.995] disabled:cursor-default sm:text-base",
      isSelected && !feedback && "border-brand bg-brand/[0.08]",
      feedback &&
        optionIsCorrect(optionId) &&
        "border-emerald-500/55 bg-emerald-500/10",
      feedback &&
        isSelected &&
        !optionIsCorrect(optionId) &&
        "border-destructive/55 bg-destructive/10"
    )
  }

  /** Scores an answer and leaves the card retryable when the request fails. */
  async function scoreAnswer(answer: LearningAnswer): Promise<void> {
    if (pending || feedback) return
    setPending(true)
    setError("")
    try {
      const result = await submitWalkthroughAnswer(projectId, item.id, answer)
      if (result.status === "invalid") {
        setError("That answer could not be checked. Try again.")
        return
      }
      setFeedback(result)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not check that answer."
      )
    } finally {
      setPending(false)
    }
  }

  /** Selects one answer and immediately asks the server to score it. */
  function selectOption(optionId: string): void {
    setSelected(optionId)
    void scoreAnswer(answerForOption(item, optionId))
  }

  /** Toggles one answer in an exact multiple-answer set. */
  function toggleOption(optionId: string): void {
    setSelectedMany((current) =>
      current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
    )
  }

  const chatHref = `/chat?cardProjectId=${encodeURIComponent(projectId)}&cardId=${encodeURIComponent(item.id)}`
  const deepDivePrompt = buildDeepDivePrompt(conceptTitle, item.title)
  const deepDiveHref = `${chatHref}&prompt=${encodeURIComponent(deepDivePrompt)}`
  const detailedExplanation =
    item.deepExplanation?.trim() ||
    item.body?.trim() ||
    "A longer explanation is not available for this card yet."

  /** Renders the quick-reading face and keeps the existing answer interaction intact. */
  const frontFace = (
    <div className="flex min-h-full flex-col justify-between">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-xs font-medium tracking-wide text-brand uppercase">
            {isExplanation ? (
              <SparklesIcon size={15} aria-hidden="true" />
            ) : (
              <HelpIcon size={15} aria-hidden="true" />
            )}
            {isExplanation ? "Walkthrough" : "Quick check"}
          </span>
          <span className="text-xs text-muted-foreground">
            {position + 1} of {total}
          </span>
        </div>

        <p className="mt-6 text-sm font-medium text-muted-foreground">
          {conceptTitle}
        </p>
        <h2 className="mt-2 max-w-2xl font-heading text-[clamp(2rem,5vw,3.35rem)] leading-[1.02] font-medium tracking-[-0.04em]">
          {isExplanation ? item.title : item.question}
        </h2>

        {isExplanation ? (
          <div className="mt-7 max-w-[68ch] text-base leading-7 text-foreground/[0.82] sm:text-lg sm:leading-8 [&_.chat-markdown]:space-y-4 [&_.chat-markdown_p]:leading-[inherit]">
            <Markdown text={item.body ?? ""} />
          </div>
        ) : (
          <div
            className="mt-7 space-y-3"
            role={isMultipleAnswer ? "group" : "radiogroup"}
            aria-label={
              isMultipleAnswer ? "Select all that apply" : "Answer options"
            }
            aria-busy={pending}
          >
            {isMultipleAnswer ? (
              <p className="pb-1 text-sm text-muted-foreground">
                Select all that apply
              </p>
            ) : null}
            {optionsForItem(item).map((option, optionIndex) => {
              const isSelected = isMultipleAnswer
                ? selectedMany.includes(option.id)
                : selected === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  role={isMultipleAnswer ? "checkbox" : "radio"}
                  aria-checked={isSelected}
                  disabled={pending || feedback !== null}
                  className={optionClass(option.id, isSelected)}
                  onClick={() =>
                    isMultipleAnswer
                      ? toggleOption(option.id)
                      : selectOption(option.id)
                  }
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-xl border bg-muted/60 text-xs font-medium text-muted-foreground",
                      isSelected && !feedback && "border-brand/60 text-brand",
                      feedback &&
                        optionIsCorrect(option.id) &&
                        "border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                      feedback &&
                        isSelected &&
                        !optionIsCorrect(option.id) &&
                        "border-destructive/60 bg-destructive/15 text-destructive"
                    )}
                  >
                    {feedback && optionIsCorrect(option.id) ? (
                      <CheckIcon size={15} aria-hidden="true" />
                    ) : item.type === "true-false" ? (
                      option.text.slice(0, 1)
                    ) : (
                      String.fromCharCode(65 + optionIndex)
                    )}
                  </span>
                  <span className="flex-1">{option.text}</span>
                </button>
              )
            })}
            {isMultipleAnswer && !feedback ? (
              <Button
                type="button"
                disabled={!selectedMany.length || pending}
                onClick={() => void scoreAnswer(selectedMany)}
                className="mt-2 min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
              >
                {pending ? "Checking…" : "Check answers"}
              </Button>
            ) : null}
          </div>
        )}

        {feedback ? (
          <div
            className={cn(
              "mt-6 rounded-2xl border px-4 py-4",
              feedback.isCorrect
                ? "border-emerald-500/35 bg-emerald-500/[0.08]"
                : "border-destructive/35 bg-destructive/[0.08]"
            )}
            role="status"
          >
            <p className="font-medium">
              {feedback.isCorrect ? "Correct" : "Not quite"}
            </p>
            {feedback.feedback?.body ? (
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {feedback.feedback.body}
              </p>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-5 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
        <Button
          asChild
          variant="outline"
          className="min-h-11 rounded-full px-4"
        >
          <Link href={chatHref}>
            <ZapIcon aria-hidden="true" /> Ask Codex
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isExplanation ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 rounded-full px-4"
              onClick={() => setFlipped(true)}
            >
              <Refresh04Icon aria-hidden="true" /> See more detail
            </Button>
          ) : null}
          {onNext ? (
            <Button
              type="button"
              onClick={handleNext}
              className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              Next card
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )

  /** Renders the source-grounded deeper explanation with expandable full detail. */
  const backFace = (
    <div className="flex min-h-full flex-col justify-between">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-xs font-medium tracking-wide text-brand uppercase">
            <SparklesIcon size={15} aria-hidden="true" /> In-depth explanation
          </span>
          <span className="text-xs text-muted-foreground">
            {position + 1} of {total}
          </span>
        </div>

        <p className="mt-6 text-sm font-medium text-muted-foreground">
          {conceptTitle}
        </p>
        <h2 className="mt-2 max-w-2xl font-heading text-[clamp(2rem,5vw,3.35rem)] leading-[1.02] font-medium tracking-[-0.04em]">
          {item.title}
        </h2>

        <div
          id={`walkthrough-deep-explanation-${item.id}`}
          className={cn(
            "relative mt-7 max-w-[68ch] text-base leading-7 text-foreground/[0.82] transition-[max-height] duration-300 ease-in-out sm:text-lg sm:leading-8 [&_.chat-markdown]:space-y-4 [&_.chat-markdown_p]:leading-[inherit] motion-reduce:transition-none",
            isExpandable && !expanded
              ? "max-h-[4.5rem] overflow-hidden sm:max-h-[5.25rem]"
              : "max-h-[2000px]"
          )}
        >
          <Markdown text={detailedExplanation} />
          {isExpandable ? (
            <div
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent transition-opacity duration-200 motion-reduce:transition-none",
                expanded ? "opacity-0" : "opacity-100"
              )}
            />
          ) : null}
        </div>

        {isExpandable ? (
          <div className="mt-2.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-controls={`walkthrough-deep-explanation-${item.id}`}
              onClick={() => setExpanded((prev) => !prev)}
              className="-ml-2 h-7 gap-1.5 rounded-full px-2.5 text-xs font-semibold text-brand hover:bg-brand/10 hover:text-brand focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{expanded ? "Show less" : "Show more"}</span>
              <ArrowDownIcon
                size={14}
                aria-hidden="true"
                className={cn(
                  "transition-transform duration-200 motion-reduce:transition-none",
                  expanded && "rotate-180"
                )}
              />
            </Button>
          </div>
        ) : null}

        {isExpandable && !expanded ? null : (
          <p className="mt-6 max-w-[68ch] text-sm leading-6 text-muted-foreground">
            Want to connect this idea to the rest of your material?
          </p>
        )}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
        <Button
          asChild
          variant="outline"
          className="min-h-11 rounded-full px-4"
        >
          <Link href={deepDiveHref}>
            <AiSearch01Icon aria-hidden="true" /> Delve Deeper
          </Link>
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 rounded-full px-4"
            onClick={handleFlipToFront}
          >
            <Refresh04Icon aria-hidden="true" /> Show front
          </Button>
          {onNext ? (
            <Button
              type="button"
              onClick={handleNext}
              className="min-h-11 rounded-full bg-brand px-5 text-brand-foreground hover:bg-brand/85"
            >
              Next card
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  )

  return (
    <article className="my-auto w-full max-w-[760px]">
      {isExplanation ? (
        <div className="[perspective:1400px]">
          <div
            className={cn(
              "grid transition-transform duration-500 [transform-style:preserve-3d] motion-reduce:transition-none",
              flipped && "[transform:rotateY(180deg)]"
            )}
          >
            <div
              aria-hidden={flipped}
              inert={flipped ? true : undefined}
              className={cn(
                "col-start-1 row-start-1 [backface-visibility:hidden] [-webkit-backface-visibility:hidden]",
                cardFaceClass,
                flipped && "pointer-events-none"
              )}
            >
              {frontFace}
            </div>
            <div
              aria-hidden={!flipped}
              inert={!flipped ? true : undefined}
              className={cn(
                "col-start-1 row-start-1 [transform:rotateY(180deg)] [backface-visibility:hidden] [-webkit-backface-visibility:hidden]",
                cardFaceClass,
                !flipped && "pointer-events-none"
              )}
            >
              {backFace}
            </div>
          </div>
        </div>
      ) : (
        <div className={cardFaceClass}>{frontFace}</div>
      )}
    </article>
  )
}
