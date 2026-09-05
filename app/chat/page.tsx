"use client"

/** Reopens a persisted card conversation from background activity or a notice. */

import Link from "next/link"
import { use } from "react"
import { useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { FeedChatDialog } from "@/components/feed/feed-chat-dialog"
import { Button } from "@/components/ui/button"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** Loads the referenced attachment independently of the current feed ordering. */
export default function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string; itemId?: string }>
}) {
  const { projectId, itemId } = use(searchParams)
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
  return (
    <main className="mx-auto max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <h1 className="text-3xl font-medium">Chat</h1>
      {!projectId || !itemId ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Open a conversation from a card or Activity.
        </p>
      ) : !card ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          Loading chat…
        </p>
      ) : (
        <FeedChatDialog
          card={card}
          open
          onOpenChange={(open) => {
            if (!open) router.push("/activity")
          }}
        />
      )}
      <Button asChild variant="outline" className="mt-6">
        <Link href="/activity">Back to activity</Link>
      </Button>
    </main>
  )
}
