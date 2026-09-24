"use client"

/** Renders a project-scoped written-answer activity over existing explanations. */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { WritingActivity } from "@/convex/writing"
import { useMutation, useQuery } from "convex/react"

/** Props for one project written-answer activity. */
export type WrittenActivityProps = {
  projectId: string
  topicId?: string
}

type ActivityAction = "draft" | "compare"

/** Creates a stable request key used when starting or resuming an activity. */
function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Reads an actionable error from a failed Convex action. */
function readActivityError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : ""
  const knownErrors: Array<[string, string]> = [
    [
      "Written practice scan limit reached",
      "This collection is too large to scan here. Choose a different topic.",
    ],
    [
      "No explanation material is available",
      "No explanation prompts are ready for this activity.",
    ],
    ["Project not found", "This project could not be found."],
    [
      "Topic does not belong to project",
      "This topic is not part of the project.",
    ],
    ["Request ID is required", "The activity could not start. Try again."],
    ["Request ID is too long", "The activity could not start. Try again."],
    [
      "Written activity could not be created",
      "The activity could not start. Try again.",
    ],
    [
      "Written activity could not be saved",
      "The answer could not be saved. Try again.",
    ],
    [
      "Written activity does not belong to project",
      "The answer could not be saved. Try again.",
    ],
    [
      "Item does not belong to written activity",
      "That prompt is no longer available.",
    ],
    [
      "Written item is no longer available",
      "That prompt is no longer available.",
    ],
    ["Answer is required", "Write an answer before saving it."],
    ["Answer is too long", "Keep your answer under 10,000 characters."],
    [
      "Revealed answers cannot be changed",
      "This answer has already been compared.",
    ],
  ]
  return knownErrors.find(([known]) => message.includes(known))?.[1] ?? fallback
}

/** Renders one bounded written-answer activity and its server-backed review. */
export function WrittenActivity({ projectId, topicId }: WrittenActivityProps) {
  const projectKey = projectId as Id<"projects">
  const topicKey = topicId as Id<"topics"> | undefined
  const scope = useMemo(
    () =>
      topicKey
        ? { projectId: projectKey, topicId: topicKey }
        : { projectId: projectKey },
    [projectKey, topicKey]
  )
  const loadedActivity = useQuery(api.writing.getLatest, scope)
  const startActivity = useMutation(api.writing.start)
  const saveAnswer = useMutation(api.writing.saveAnswer)
  const [requestId, setRequestId] = useState(createRequestId)
  const [activityOverride, setActivityOverride] = useState<WritingActivity>()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [draftAnswers, setDraftAnswers] = useState<Record<string, string>>({})
  const [startPending, setStartPending] = useState(false)
  const [pendingAction, setPendingAction] = useState<ActivityAction>()
  const [error, setError] = useState("")
  const [draftSaved, setDraftSaved] = useState(false)
  const startAttempted = useRef(false)
  const positionedActivityId = useRef<string | null>(null)

  const activity =
    activityOverride &&
    (loadedActivity === null ||
      loadedActivity === undefined ||
      loadedActivity.updatedAt < activityOverride.updatedAt)
      ? activityOverride
      : loadedActivity
  const item = activity?.items[currentIndex]
  const draftAnswer = item
    ? (draftAnswers[item.itemId] ?? item.answer ?? "")
    : ""
  const hasReference = item?.revealed === true

  // Resume at the first unfinished prompt once per activity. Saving an answer
  // keeps the current reference visible until the learner chooses Next.
  useEffect(() => {
    if (!activity || positionedActivityId.current === activity._id) return
    positionedActivityId.current = activity._id
    const unfinishedIndex = activity.items.findIndex((entry) => !entry.revealed)
    setCurrentIndex(
      unfinishedIndex < 0 ? activity.items.length - 1 : unfinishedIndex
    )
  }, [activity])

  /** Starts one activity request and leaves retry decisions to the user. */
  const beginActivity = useCallback(
    async (nextRequestId: string): Promise<void> => {
      startAttempted.current = true
      setStartPending(true)
      setError("")
      try {
        const started = await startActivity({
          ...scope,
          requestId: nextRequestId,
        })
        setActivityOverride(started ?? undefined)
      } catch (reason: unknown) {
        setError(
          readActivityError(reason, "The written activity could not start.")
        )
      } finally {
        setStartPending(false)
      }
    },
    [scope, startActivity]
  )

  useEffect(() => {
    if (loadedActivity !== null || startAttempted.current || startPending)
      return
    void beginActivity(requestId)
  }, [
    beginActivity,
    loadedActivity,
    requestId,
    scope,
    startActivity,
    startPending,
  ])

  /** Saves a draft or compares the answer, then applies the server activity snapshot. */
  async function submitAnswer(reveal: boolean): Promise<void> {
    if (!activity || !item || !draftAnswer.trim() || pendingAction) return
    const action: ActivityAction = reveal ? "compare" : "draft"
    setPendingAction(action)
    setError("")
    try {
      const updated = await saveAnswer({
        projectId: projectKey,
        activityId: activity._id,
        itemId: item.itemId,
        answer: draftAnswer,
        reveal,
      })
      setActivityOverride(updated)
      setDraftSaved(!reveal)
    } catch (reason: unknown) {
      setError(
        readActivityError(
          reason,
          reveal
            ? "The answer could not be compared."
            : "The draft could not be saved."
        )
      )
    } finally {
      setPendingAction(undefined)
    }
  }

  /** Moves between prompts without changing the saved server answer. */
  function moveTo(index: number): void {
    if (!activity || index < 0 || index >= activity.items.length) return
    setCurrentIndex(index)
    setError("")
    setDraftSaved(false)
  }

  /** Starts a fresh activity after the current five prompts are complete. */
  function startNewActivity(): void {
    if (startPending) return
    const nextRequestId = createRequestId()
    setRequestId(nextRequestId)
    setActivityOverride(undefined)
    setCurrentIndex(0)
    setDraftAnswers({})
    setDraftSaved(false)
    void beginActivity(nextRequestId)
  }

  /** Retries a failed initial start after the learner explicitly requests it. */
  function retryStart(): void {
    if (startPending) return
    void beginActivity(requestId)
  }

  if (loadedActivity === undefined && !activityOverride)
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-5 py-10 font-sans text-foreground">
        <p className="text-sm text-muted-foreground" role="status">
          Loading written activity…
        </p>
      </main>
    )

  if (loadedActivity === null && !activityOverride && startPending)
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-5 py-10 font-sans text-foreground">
        <p className="text-sm text-muted-foreground" role="status">
          Starting written activity…
        </p>
      </main>
    )

  if (!activity || !item)
    return (
      <main className="flex min-h-svh flex-col justify-center gap-5 bg-background px-5 py-10 font-sans text-foreground sm:px-8">
        <div className="mx-auto w-full max-w-2xl space-y-5">
        <Link
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Exit
        </Link>
        <h1 className="font-heading text-3xl font-medium tracking-tight">Write</h1>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No explanation prompts are ready for this activity.
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={retryStart}
          disabled={startPending}
          className="w-fit"
        >
          Try again
        </Button>
        </div>
      </main>
    )

  return (
    <main className="min-h-svh bg-background px-4 py-4 font-sans text-foreground sm:px-8 sm:py-6">
      <div className="mx-auto flex max-w-4xl items-center justify-between border-b border-border pb-3">
        <h1 className="text-sm font-medium">Write</h1>
        <Link
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="rounded-md px-3 py-2 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Exit
        </Link>
      </div>

      <div className="mx-auto w-full max-w-3xl py-6 sm:py-8">
        <p className="text-xs text-muted-foreground" role="status">
          Prompt {currentIndex + 1} of {activity.items.length}
          {draftSaved ? " · Draft saved" : ""}
        </p>
        <h2 className="mt-4 font-heading text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
          {item.prompt}
        </h2>

        {hasReference ? (
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <section aria-labelledby="saved-answer-heading" className="space-y-2">
              <h3 id="saved-answer-heading" className="text-sm font-medium">Your answer</h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {item.answer}
              </p>
            </section>
            <section aria-labelledby="source-guide-heading" className="space-y-2 border-t border-border pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-5">
              <h3 id="source-guide-heading" className="text-sm font-medium">Source guide</h3>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {item.reference}
              </p>
              <p className="text-xs text-muted-foreground">
                {item.sourceLabels.join(", ")}
              </p>
            </section>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <label htmlFor="written-answer" className="text-sm font-medium">
              Your answer
            </label>
            <Textarea
              id="written-answer"
              value={draftAnswer}
              onChange={(event) => {
                setDraftAnswers((current) => ({
                  ...current,
                  [item.itemId]: event.target.value,
                }))
                setDraftSaved(false)
                setError("")
              }}
              rows={8}
              maxLength={10_000}
              className="min-h-44 resize-y bg-card text-base leading-relaxed"
              disabled={pendingAction !== undefined}
            />
          </div>
        )}

        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>
        ) : null}

        <nav aria-label="Written activity prompts" className="mt-6 flex flex-wrap justify-between gap-2">
          {currentIndex > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => moveTo(currentIndex - 1)}
              disabled={pendingAction !== undefined}
            >
              Previous
            </Button>
          ) : <span />}

          {hasReference ? (
            currentIndex < activity.items.length - 1 ? (
              <Button
                type="button"
                onClick={() => moveTo(currentIndex + 1)}
                disabled={pendingAction !== undefined}
              >
                Next prompt
              </Button>
            ) : activity.status === "completed" ? (
              <Button
                type="button"
                onClick={startNewActivity}
                disabled={startPending || pendingAction !== undefined}
              >
                {startPending ? "Starting…" : "New activity"}
              </Button>
            ) : null
          ) : (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void submitAnswer(false)}
                disabled={!draftAnswer.trim() || pendingAction !== undefined}
              >
                {pendingAction === "draft" ? "Saving…" : "Save draft"}
              </Button>
              <Button
                type="button"
                onClick={() => void submitAnswer(true)}
                disabled={!draftAnswer.trim() || pendingAction !== undefined}
              >
                {pendingAction === "compare" ? "Comparing…" : "Compare answer"}
              </Button>
            </div>
          )}
        </nav>
      </div>
    </main>
  )
}
