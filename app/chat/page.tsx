"use client"

/**
 * Opens general workspace chat or a new card chat. Legacy card deep links
 * (`projectId` and `itemId`) open the project's workspace chat.
 */

import { use } from "react"
import { useQuery } from "convex/react"
import { ChatWorkspace } from "@/components/chat/chat-workspace"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** Accepts only the lowercase encoded shape used by Convex document IDs. */
function chatIdFromQuery(value?: string): Id<"workspaceChats"> | undefined {
  return value && /^[a-z0-9]{32}$/.test(value)
    ? (value as Id<"workspaceChats">)
    : undefined
}

/** Routes card links and legacy card links to workspace chat. */
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
      key={`${workingProject?._id ?? "chat"}:${chatId ?? "new"}`}
      initialChatId={chatIdFromQuery(chatId)}
      initialProject={
        workingProject
          ? { _id: workingProject._id, title: workingProject.title }
          : undefined
      }
    />
  )
}
