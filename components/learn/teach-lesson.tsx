"use client"

/**
 * Renders a Teach session as a lesson: tutor replies become section pages with
 * citations and interactive blocks, quick replies become quiet dividers, and
 * the learner's own questions stay visible as chat bubbles.
 */

import type { FunctionReturnType } from "convex/server"
import { memo, useMemo } from "react"

import { ReadAloudButton } from "@/components/chat/read-aloud-button"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { InteractiveBlocksProvider } from "@/components/ui/interactive-blocks"
import { Markdown } from "@/components/ui/markdown"
import type { api } from "@/convex/_generated/api"
import type { ChatCitation } from "@/lib/citations"
import type { QuizBlock } from "@/lib/interactive-blocks"
import {
  isTeachPrecheck,
  parseTeachOutline,
  parseTeachSectionMarker,
  stripTeachMarkers,
  TEACH_QUICK_REPLIES,
  type TeachOutline,
} from "@/lib/teach"

/** One saved message from the Teach session. */
export type TeachMessage = NonNullable<
  FunctionReturnType<typeof api.workspaceChats.get>
>["messages"][number]

/** Latest answers keyed by message ID, then quiz ID. */
export type AnsweredQuizzes = FunctionReturnType<typeof api.teach.answeredQuizzes>

/** Quick replies shown as dividers rather than chat bubbles. */
const QUICK_REPLY_TEXT = new Set<string>(Object.values(TEACH_QUICK_REPLIES))

/** Returns whether a learner message is a quick reply or an outline jump. */
export function isNavigationMessage(content: string): boolean {
  return QUICK_REPLY_TEXT.has(content.trim()) || /^Teach section \d+:/i.test(content.trim())
}

/** Props for the lesson stream. */
type TeachLessonProps = {
  messages: TeachMessage[]
  outline: TeachOutline | null
  unitTitle: string
  answered: AnsweredQuizzes | undefined
  onCitation: (messageId: string, citation: ChatCitation) => void
  onQuizAnswer: (
    messageId: string,
    block: QuizBlock,
    selectedOptionIds: string[]
  ) => Promise<{ correct: boolean } | null>
  onFollowUp: (text: string) => void
  /** Disables follow-up chips while a reply is being written. */
  busy: boolean
}

/**
 * Renders every message in order. Each tutor reply that starts a section is
 * anchored with `id="teach-section-<id>"` so the outline can scroll to it.
 */
export function TeachLesson({
  messages,
  outline,
  unitTitle,
  answered,
  onCitation,
  onQuizAnswer,
  onFollowUp,
  busy,
}: TeachLessonProps) {
  return (
    <div className="space-y-10">
      {messages.map((message, index) =>
        message.role === "user" ? (
          // The opening request is implied by the screen itself.
          index === 0 && message.content.trim() === TEACH_QUICK_REPLIES.start ? null : (
            <LearnerMessage key={message.id} content={message.content} />
          )
        ) : (
          <TutorReply
            key={message.id}
            message={message}
            outline={outline}
            unitTitle={unitTitle}
            answered={answered?.[message.id]}
            onCitation={onCitation}
            onQuizAnswer={onQuizAnswer}
            onFollowUp={busy ? undefined : onFollowUp}
          />
        )
      )}
    </div>
  )
}

/** Shows a learner turn: a divider for quick replies, a bubble for questions. */
function LearnerMessage({ content }: { content: string }) {
  if (isNavigationMessage(content))
    return (
      <div className="flex items-center gap-3 text-xs text-muted-foreground" role="note">
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        <span>{content.trim()}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
    )
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-[15px] whitespace-pre-wrap break-words">
        <span className="sr-only">You asked: </span>
        {content}
      </p>
    </div>
  )
}

/** Props for one tutor reply. */
type TutorReplyProps = {
  message: TeachMessage
  outline: TeachOutline | null
  unitTitle: string
  answered: Record<string, { selectedOptionIds: string[]; correct: boolean }> | undefined
  onCitation: TeachLessonProps["onCitation"]
  onQuizAnswer: TeachLessonProps["onQuizAnswer"]
  onFollowUp: ((text: string) => void) | undefined
}

/**
 * Renders one tutor reply with its section heading and read aloud control, the plan on the first
 * reply, the lesson body, and a waiting state before the first words arrive.
 * Memoised because a streaming reply re-renders several times a second.
 */
const TutorReply = memo(function TutorReply({
  message,
  outline,
  unitTitle,
  answered,
  onCitation,
  onQuizAnswer,
  onFollowUp,
}: TutorReplyProps) {
  const streaming = message.status === "running"
  const marker = useMemo(() => parseTeachSectionMarker(message.content), [message.content])
  const plan = useMemo(() => parseTeachOutline(message.content), [message.content])
  const precheck = useMemo(() => isTeachPrecheck(message.content), [message.content])
  const body = useMemo(() => stripTeachMarkers(message.content), [message.content])
  const sectionNumber =
    marker?.kind === "section" && outline
      ? outline.sections.findIndex((section) => section.id === marker.id)
      : -1
  const interactive = useMemo(
    () => ({
      streaming,
      answeredQuizzes: answered,
      onQuizAnswer: (block: QuizBlock, selected: string[]) =>
        onQuizAnswer(message.id, block, selected),
      ...(onFollowUp ? { onFollowUp } : {}),
    }),
    [streaming, answered, onQuizAnswer, onFollowUp, message.id]
  )

  return (
    <article
      id={
        marker?.kind === "section"
          ? `teach-section-${marker.id}`
          : marker?.kind === "done"
            ? "teach-section-done"
            : undefined
      }
      aria-label={
        sectionNumber >= 0
          ? `Section ${sectionNumber + 1}: ${outline!.sections[sectionNumber].title}`
          : marker?.kind === "done"
            ? "Unit recap"
            : "Tutor reply"
      }
      data-message-id={message.id}
      className="scroll-mt-6"
    >
      {plan ? <LessonPlan outline={plan} /> : null}
      {sectionNumber >= 0 ? (
        <header className="mb-5 flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/10 font-heading text-sm font-semibold text-brand tabular-nums"
          >
            {sectionNumber + 1}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Section {sectionNumber + 1} of {outline!.sections.length}
            </p>
            <h2 className="mt-0.5 font-heading text-2xl font-semibold tracking-tight text-balance">
              {outline!.sections[sectionNumber].title}
            </h2>
            {!streaming && body.trim() ? (
              <div className="mt-2 -ml-2.5 sm:-ml-2">
                <ReadAloudButton
                  text={`${outline!.sections[sectionNumber].title}\n\n${body}`}
                />
              </div>
            ) : null}
          </div>
        </header>
      ) : precheck ? (
        <header className="mb-4">
          <p className="text-xs font-medium text-brand">Before we start</p>
          <h2 className="mt-1 font-heading text-2xl font-semibold tracking-tight">
            Quick check
          </h2>
        </header>
      ) : marker?.kind === "done" ? (
        <header className="mb-4">
          <p className="text-xs font-medium text-brand">Unit recap</p>
          <h2 className="mt-1 font-heading text-2xl font-semibold tracking-tight">
            {outline?.title ?? unitTitle}
          </h2>
          {!streaming && body.trim() ? (
            <div className="mt-2 -ml-2.5 sm:-ml-2">
              <ReadAloudButton text={body} />
            </div>
          ) : null}
        </header>
      ) : null}
      {body.trim() ? (
        <InteractiveBlocksProvider value={interactive}>
          <Markdown
            text={body}
            citations={message.citations}
            streaming={streaming}
            onCitation={(citation) => onCitation(message.id, citation)}
          />
        </InteractiveBlocksProvider>
      ) : streaming ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <span aria-hidden="true" className="size-2 rounded-full bg-brand motion-safe:animate-pulse" />
          Reading your material…
          <ElapsedTime since={message.createdAt} />
        </p>
      ) : null}
      {message.status === "failed" && !streaming ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {body.trim() ? "This reply stopped early." : "The tutor could not reply."}
        </p>
      ) : null}
    </article>
  )
})

/** Shows the plan the tutor proposed at the start of the unit. */
function LessonPlan({ outline }: { outline: TeachOutline }) {
  return (
    <section aria-label="Lesson plan" className="mb-8 rounded-2xl border border-border bg-card p-5">
      <h2 className="font-heading text-lg font-semibold">{outline.title}</h2>
      <ol className="mt-3 grid gap-1.5 text-sm text-muted-foreground sm:grid-cols-2">
        {outline.sections.map((section, index) => (
          <li key={section.id} className="flex gap-2">
            <span className="w-5 shrink-0 text-right tabular-nums">{index + 1}.</span>
            <span className="min-w-0 break-words">{section.title}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
