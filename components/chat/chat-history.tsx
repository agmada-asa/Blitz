/** Renders the saved chat rail using the compact selected-row treatment from the reference. */

import {
  Add01Icon,
  BubbleChatIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import type { Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** Summary needed to identify and display one persisted chat. */
export type ChatHistoryItem = {
  id: Id<"workspaceChats">
  title: string
  status: "idle" | "running" | "failed"
  updatedAt: number
}

/** Data and actions shared by the desktop rail and mobile history dialog. */
type ChatHistoryProps = {
  chats?: ChatHistoryItem[]
  activeChatId?: Id<"workspaceChats">
  onSelect: (chatId: Id<"workspaceChats">) => void
  onNew: () => void
  className?: string
}

/** Displays new-chat access and recent persisted conversations. */
export function ChatHistory({
  chats,
  activeChatId,
  onSelect,
  onNew,
  className,
}: ChatHistoryProps) {
  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-col overflow-hidden",
        className
      )}
    >
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <h2 className="text-sm font-medium">Chats</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full"
          aria-label="New chat"
          onClick={onNew}
        >
          <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={1.8} />
        </Button>
      </div>
      <nav
        aria-label="Chat history"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
      >
        {chats === undefined ? (
          <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
            Loading chats…
          </p>
        ) : chats.length ? (
          <ul className="w-full min-w-0 space-y-1">
            {chats.map((chat) => {
              const selected = chat.id === activeChatId
              return (
                <li key={chat.id} className="min-w-0">
                  <button
                    type="button"
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 w-full min-w-0 items-center gap-3 overflow-hidden rounded-[18px] px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      selected && "bg-muted hover:bg-muted"
                    )}
                    onClick={() => onSelect(chat.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {chat.title}
                    </span>
                    {chat.status === "running" ? (
                      <HugeiconsIcon
                        icon={Loading03Icon}
                        size={18}
                        strokeWidth={2}
                        className="shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                        aria-label="Reply in progress"
                      />
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="px-3 py-8 text-center text-muted-foreground">
            <HugeiconsIcon
              icon={BubbleChatIcon}
              size={22}
              strokeWidth={1.6}
              className="mx-auto"
              aria-hidden="true"
            />
            <p className="mt-3 text-xs leading-5">
              Your saved chats will appear here.
            </p>
          </div>
        )}
      </nav>
    </div>
  )
}
