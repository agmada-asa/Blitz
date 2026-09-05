"use client"

/** Renders generated project topics with compact rename and feed controls. */

import Link from "next/link"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { useMutation, useQuery } from "convex/react"

/** Identifies the project whose generated topics are being organized. */
type TopicListProps = {
  projectId: Id<"projects">
}

/** Returns a safe mutation error message for the inline topic controls. */
function topicErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const message = error.message.trim()
  const knownMessages = [
    "Topic title is required",
    "Topic title is too long",
    "A topic with that name already exists",
    "Topic not found",
    "Project not found",
    "Topic does not belong to project",
  ]
  return knownMessages.find((known) => message.includes(known)) ?? fallback
}

/** Renders generated topics with scoped study links and reversible controls. */
export function TopicList({ projectId }: TopicListProps) {
  const topics = useQuery(api.topics.listForProject, { projectId })
  const renameTopic = useMutation(api.topics.rename)
  const setFeedInclusion = useMutation(api.topics.setFeedInclusion)
  const [editingTopicId, setEditingTopicId] = useState<Id<"topics"> | null>(
    null
  )
  const [draftTitle, setDraftTitle] = useState("")
  const [pendingTopicId, setPendingTopicId] = useState<Id<"topics"> | null>(
    null
  )
  const [error, setError] = useState("")
  const [showAllTopics, setShowAllTopics] = useState(false)

  /** Starts editing one topic without changing its persisted title. */
  function startEditing(topic: NonNullable<typeof topics>[number]): void {
    setEditingTopicId(topic._id)
    setDraftTitle(topic.title)
    setError("")
  }

  /** Closes the inline editor and restores the read-only topic row. */
  function cancelEditing(): void {
    setEditingTopicId(null)
    setDraftTitle("")
  }

  /** Saves a bounded topic rename and keeps the editor open when it fails. */
  async function saveRename(topicId: Id<"topics">): Promise<void> {
    setPendingTopicId(topicId)
    setError("")
    try {
      await renameTopic({ projectId, topicId, title: draftTitle })
      cancelEditing()
    } catch (reason) {
      setError(topicErrorMessage(reason, "The topic could not be renamed."))
    } finally {
      setPendingTopicId(null)
    }
  }

  /** Toggles home-feed inclusion while keeping deliberate topic study available. */
  async function toggleFeed(
    topic: NonNullable<typeof topics>[number]
  ): Promise<void> {
    setPendingTopicId(topic._id)
    setError("")
    try {
      await setFeedInclusion({
        projectId,
        topicId: topic._id,
        included: topic.excludedFromFeed,
      })
    } catch (reason) {
      setError(
        topicErrorMessage(reason, "The feed setting could not be saved.")
      )
    } finally {
      setPendingTopicId(null)
    }
  }

  if (topics === undefined)
    return (
      <section aria-labelledby="topics-heading" className="mt-10 font-sans">
        <h2 id="topics-heading" className="font-heading text-2xl">
          Topics
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">Loading topics…</p>
      </section>
    )

  if (!topics.length) return null

  const visibleTopics = showAllTopics ? topics : topics.slice(0, 6)
  const hasMoreTopics = topics.length > 6
  const projectPath = encodeURIComponent(String(projectId))

  return (
    <section aria-labelledby="topics-heading" className="mt-10 font-sans">
      <h2 id="topics-heading" className="font-heading text-2xl">
        Topics
      </h2>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ul
        id="project-topic-list"
        className="mt-4 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
      >
        {visibleTopics.map((topic) => {
          const editing = editingTopicId === topic._id
          const pending = pendingTopicId === topic._id
          const topicPath = encodeURIComponent(String(topic._id))
          const feedHref = `/?projectId=${projectPath}&topicId=${topicPath}`
          return (
            <li
              key={topic._id}
              className="border-b border-border/60 px-3 last:border-b-0 sm:px-4"
            >
              <div className="flex min-h-11 flex-wrap items-center justify-between gap-2">
                {editing ? (
                  <form
                    className="flex min-w-0 flex-1 flex-wrap gap-2 py-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveRename(topic._id)
                    }}
                  >
                    <Input
                      aria-label={`Rename ${topic.title}`}
                      value={draftTitle}
                      disabled={pending}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") cancelEditing()
                      }}
                      autoFocus
                      className="h-11 min-w-[min(100%,14rem)] flex-1 rounded-lg"
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={pending || !draftTitle.trim()}
                      className="min-h-11 rounded-lg"
                    >
                      {pending ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={cancelEditing}
                      className="min-h-11"
                    >
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Link
                      href={feedHref}
                      className="flex min-h-11 min-w-0 flex-1 items-center py-2 font-medium break-words hover:underline"
                    >
                      {topic.title}
                    </Link>
                    {topic.excludedFromFeed ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Excluded
                      </span>
                    ) : null}
                  </div>
                )}

                {!editing ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="size-11 shrink-0"
                          disabled={pending}
                          aria-label={`Options for ${topic.title}`}
                        >
                          <span aria-hidden="true">•••</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/projects/${projectPath}/practice?topicId=${topicPath}`}
                          >
                            Study
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem asChild>
                          <Link
                            href={`/projects/${projectPath}/test?topicId=${topicPath}`}
                          >
                            Test
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={pending}
                          onSelect={() => startEditing(topic)}
                        >
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={pending}
                          onSelect={() => void toggleFeed(topic)}
                        >
                          {topic.excludedFromFeed
                            ? "Include in home"
                            : "Exclude from home"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {hasMoreTopics ? (
        <Button
          type="button"
          variant="ghost"
          aria-expanded={showAllTopics}
          aria-controls="project-topic-list"
          onClick={() => setShowAllTopics((current) => !current)}
          className="mt-2 min-h-11 px-3 text-muted-foreground hover:text-foreground"
        >
          {showAllTopics ? "Show fewer" : "Show all topics"}
        </Button>
      ) : null}
    </section>
  )
}
