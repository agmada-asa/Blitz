"use client"

/** Opens general workspace chat, a new card chat, or a legacy card deep link. */

import Link from "next/link"
import { use } from "react"
import { useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { FeedChatDialog } from "@/components/feed/feed-chat-dialog"
import { ChatWorkspace } from "@/components/chat/chat-workspace"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** Accepts only the lowercase encoded shape used by Convex document IDs. */
function chatIdFromQuery(value?: string): Id<"workspaceChats"> | undefined {
  return value && /^[a-z0-9]{32}$/.test(value)
    ? (value as Id<"workspaceChats">)
    : undefined
}

/** Routes new card links to workspace chat while keeping legacy card links readable. */
export default function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{
    projectId?: string
    itemId?: string
    cardProjectId?: string
    cardId?: string
    prompt?: string
    chatId?: string
  }>
}) {
  const { projectId, itemId, cardProjectId, cardId, prompt, chatId } =
    use(searchParams)
  const router = useRouter()
  const card = useQuery(
    api.conversations.getAttachment,
    projectId && itemId
      ? {
          projectId: projectId as Id<"projects">,
          itemId: itemId as Id<"learningItems">,
        }
      : "skip"
  )
  const newCard = useQuery(
    api.conversations.getAttachment,
    cardProjectId && cardId
      ? {
          projectId: cardProjectId as Id<"projects">,
          itemId: cardId as Id<"learningItems">,
        }
      : "skip"
  )
  const workingProject = useQuery(
    api.projects.getProject,
    projectId ? { projectId: projectId as Id<"projects"> } : "skip"
  )
  if (cardProjectId && cardId) {
    if (newCard === undefined)
      return (
        <main className="flex min-h-[calc(100svh-68px-env(safe-area-inset-bottom))] items-center justify-center px-5">
          <p className="text-sm text-muted-foreground" role="status">
            Loading card…
          </p>
        </main>
      )
    if (!newCard)
      return (
        <main className="flex min-h-[calc(100svh-68px-env(safe-area-inset-bottom))] items-center justify-center px-5">
          <p className="text-sm text-muted-foreground" role="status">
            That card is no longer available.
          </p>
        </main>
      )
    return (
      <ChatWorkspace
        key={`${newCard.projectId}:${newCard.id}`}
        initialCard={newCard}
        initialPrompt={prompt}
      />
    )
  }
  if (!projectId || !itemId)
    if (projectId && workingProject === undefined)
      return (
        <main className="flex min-h-[calc(100svh-68px-env(safe-area-inset-bottom))] items-center justify-center px-5">
          <p className="text-sm text-muted-foreground" role="status">
            Loading project…
          </p>
        </main>
      )
  if (projectId && workingProject === null)
    return (
      <main className="flex min-h-[calc(100svh-68px-env(safe-area-inset-bottom))] items-center justify-center px-5">
        <p className="text-sm text-destructive" role="alert">
          That project is no longer available.
        </p>
      </main>
    )
  return (
    <ChatWorkspace
      key={workingProject?._id ?? "chat"}
      initialChatId={chatIdFromQuery(chatId)}
      initialProject={
        workingProject
          ? { _id: workingProject._id, title: workingProject.title }
          : undefined
      }
    />
  )

  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <h1 className="text-3xl font-medium">Chat</h1>
      {!card ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Loading chat…
        </p>
      ) : (
        <FeedChatDialog
          card={card ?? null}
          open
          onOpenChange={(open) => {
            if (!open) router.push("/notifications")
          }}
        />
      )}
      <Button asChild variant="outline" className="mt-6">
        <Link href="/chat">Open workspace chat</Link>
      </Button>
    </main>
  )
}
