"use client"

/** Opens a saved citation in a standalone tab while sharing the chat source reader. */
import { use } from "react"
import { SourceReader } from "@/components/chat/source-pane"
import type { Id } from "@/convex/_generated/dataModel"

/** Resolves the citation link parameters and displays its source independently of the chat. */
export default function SourcePage({
  searchParams,
}: {
  searchParams: Promise<{
    chatId?: string
    messageId?: string
    citationId?: string
  }>
}) {
  const { chatId, messageId, citationId } = use(searchParams)
  if (!chatId || !messageId || !citationId)
    return (
      <p className="p-6">Open a citation from a chat to read its source.</p>
    )
  return (
    <main className="mx-auto flex h-[calc(100svh-68px-env(safe-area-inset-bottom))] max-w-5xl flex-col md:h-svh">
      <SourceReader
        selection={{
          chatId: chatId as Id<"workspaceChats">,
          messageId: messageId as Id<"workspaceChatMessages">,
          citationId,
        }}
      />
    </main>
  )
}
