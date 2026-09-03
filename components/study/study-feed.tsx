"use client"

/** Loads a project deck and progress, then renders the vertical study session. */

import { useMemo, useState } from "react"
import Link from "next/link"
import { useMutation, useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { StudyCard, type StudyCardData } from "@/components/study/study-card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowLeftIcon, BookOpenIcon, LoadingIcon } from "@/components/ui/icon"

/** Dynamic project identifier required by study views. */
type Props = { projectId: string }

/** Connects ordered cards and attempts to the full-height study interface. */
export function StudyFeed({ projectId }: Props) {
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const cards = useQuery(api.cards.listProjectCards, {
    projectId: convexProjectId,
  }) as StudyCardData[] | undefined
  const progressData = useQuery(api.attempts.getProjectProgress, {
    projectId: convexProjectId,
  })
  const recordAttempt = useMutation(api.attempts.recordAttempt)
  const [ratingError, setRatingError] = useState("")
  const completed = useMemo(() => progressData?.completed ?? 0, [progressData])
  const total = progressData?.total ?? cards?.length ?? 10
  const percentage = total > 0 ? (completed / total) * 100 : 0

  const rate = async (cardId: string, rating: "again" | "got_it") => {
    setRatingError("")
    try {
      await recordAttempt({
        projectId: convexProjectId,
        cardId: cardId as Id<"cards">,
        rating,
      })
    } catch {
      setRatingError("Could not save that rating. Try again.")
    }
  }

  return (
    <main className="flex h-[calc(100svh-76px)] flex-col bg-background md:h-svh">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/90 px-4 py-3 backdrop-blur-xl sm:px-8">
        <div className="mx-auto flex max-w-5xl items-center gap-4">
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Back to project"
          >
            <Link href={`/projects/${projectId}`}>
              <ArrowLeftIcon />
            </Link>
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {project?.title ?? "Study session"}
            </p>
            <div className="mt-2 flex items-center gap-3">
              <Progress
                value={percentage}
                className="h-1.5"
                aria-label="Study progress"
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {completed}/{total}
              </span>
            </div>
          </div>
        </div>
      </header>
      {ratingError ? (
        <p
          role="alert"
          className="border-b border-destructive/20 bg-destructive/10 px-4 py-2 text-center text-sm text-destructive"
        >
          {ratingError}
        </p>
      ) : null}
      {project === null ? (
        <ProjectNotFoundState />
      ) : cards === undefined ? (
        <LoadingState />
      ) : cards.length === 0 ? (
        <EmptyState projectId={projectId} />
      ) : (
        <div className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-y-contain scroll-smooth">
          {cards.map((card, index) => (
            <StudyCard
              key={card._id}
              card={card}
              index={index}
              onRate={(rating) => void rate(card._id, rating)}
            />
          ))}
        </div>
      )}
    </main>
  )
}

/** Explains that a stale or invalid study link no longer resolves. */
function ProjectNotFoundState() {
  return (
    <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 text-center">
      <div role="alert">
        <h1 className="text-3xl font-semibold tracking-tight">
          Project not found.
        </h1>
        <p className="mt-3 text-muted-foreground">
          This study session is no longer available.
        </p>
        <Button asChild className="mt-8 rounded-full">
          <Link href="/">Back to projects</Link>
        </Button>
      </div>
    </div>
  )
}

/** Shows a reduced-motion-safe loading placeholder while cards resolve. */
function LoadingState() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-6 px-6">
      <LoadingIcon
        className="size-10 animate-spin text-primary motion-reduce:animate-none"
        aria-label="Loading study cards"
      />
      <Skeleton className="h-12 w-3/4" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-12 w-40 rounded-full" />
    </div>
  )
}

/** Guides an empty project back to source generation. */
function EmptyState({ projectId }: Props) {
  return (
    <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-6 flex size-20 items-center justify-center rounded-3xl bg-primary/15 text-primary">
        <BookOpenIcon className="size-10" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">
        Your deck is empty
      </h1>
      <p className="mt-3 text-muted-foreground">
        Add a source and generate cards to start a focused study session.
      </p>
      <Button asChild className="mt-8 rounded-full">
        <Link href={`/projects/${projectId}`}>Back to project</Link>
      </Button>
    </div>
  )
}
