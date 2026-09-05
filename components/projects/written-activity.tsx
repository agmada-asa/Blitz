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
      <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center justify-center px-5 py-10 font-sans">
        <p className="text-sm text-muted-foreground" role="status">
          Loading written activity…
        </p>
      </main>
    )

  if (loadedActivity === null && !activityOverride && startPending)
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl items-center justify-center px-5 py-10 font-sans">
        <p className="text-sm text-muted-foreground" role="status">
          Starting written activity…
        </p>
      </main>
    )

  if (!activity || !item)
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-5 px-5 py-10 font-sans">
        <Link
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Back to project
        </Link>
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          Written answers
        </h1>
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
      </main>
    )

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-5 py-8 pb-16 font-sans sm:px-8 sm:py-12">
      <div className="mb-10 flex items-center justify-between gap-4">
        <Link
          href={`/projects/${encodeURIComponent(projectId)}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          Back to project
        </Link>
        {activity.status === "completed" ? (
          <p className="text-sm text-muted-foreground" role="status">
            Activity complete
          </p>
        ) : null}
      </div>

      <section className="space-y-6">
        <h1 className="font-heading text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
          {item.prompt}
        </h1>

        {hasReference ? (
          <section className="space-y-2">
            <h2 className="text-sm font-medium">Your saved answer</h2>
            <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {item.answer}
            </p>
          </section>
        ) : (
          <>
            <div className="space-y-3">
              <label
                htmlFor="written-answer"
                className="text-sm text-muted-foreground"
              >
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

            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => void submitAnswer(false)}
                disabled={!draftAnswer.trim() || pendingAction !== undefined}
              >
                {pendingAction === "draft" ? "Saving…" : "Save draft"}
              </Button>
              <Button
                type="button"
                className="min-h-11"
                onClick={() => void submitAnswer(true)}
                disabled={!draftAnswer.trim() || pendingAction !== undefined}
              >
                {pendingAction === "compare" ? "Comparing…" : "Compare answer"}
              </Button>
            </div>
            {draftSaved ? (
              <p className="text-sm text-muted-foreground" role="status">
                Draft saved.
              </p>
            ) : null}
          </>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {hasReference ? (
          <section className="space-y-4 border-t border-border pt-6">
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Reference</h2>
              <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {item.reference}
              </p>
              <p className="text-xs text-muted-foreground">
                Source: {item.sourceLabels.join(", ")}
              </p>
            </div>
          </section>
        ) : null}
      </section>

      <nav
        aria-label="Written activity prompts"
        className="mt-auto flex items-center justify-between gap-3 pt-12"
      >
        <Button
          type="button"
          variant="ghost"
          onClick={() => moveTo(currentIndex - 1)}
          disabled={currentIndex === 0 || pendingAction !== undefined}
          className="min-h-11"
        >
          Previous
        </Button>
        {currentIndex < activity.items.length - 1 ? (
          <Button
            type="button"
            onClick={() => moveTo(currentIndex + 1)}
            disabled={!hasReference || pendingAction !== undefined}
            className="min-h-11"
          >
            Next
          </Button>
        ) : activity.status === "completed" ? (
          <Button
            type="button"
            onClick={startNewActivity}
            disabled={startPending || pendingAction !== undefined}
            className="min-h-11"
          >
            {startPending ? "Starting…" : "New activity"}
          </Button>
        ) : null}
      </nav>
    </main>
  )
}
