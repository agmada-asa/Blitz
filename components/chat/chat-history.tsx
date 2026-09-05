/** Renders the saved chat rail using the compact selected-row treatment from the reference. */

import {
  Add01Icon,
  Chat01Icon,
  CheckUnread01Icon,
  Loading03Icon,
  PencilEdit02Icon,
  Pin02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** Summary needed to identify and display one persisted chat. */
export type ChatHistoryItem = {
  id: Id<"workspaceChats">
  title: string
  status: "idle" | "running" | "failed"
  isUnread: boolean
  isPinned: boolean
  updatedAt: number
}

/** Data and actions shared by the desktop rail and mobile history dialog. */
type ChatHistoryProps = {
  chats?: ChatHistoryItem[]
  activeChatId?: Id<"workspaceChats">
  onSelect: (chatId: Id<"workspaceChats">) => void
  onNew: () => void
  onRename: (chatId: Id<"workspaceChats">) => void
  onToggleUnread: (chatId: Id<"workspaceChats">, unread: boolean) => void
  onTogglePin: (chatId: Id<"workspaceChats">, pinned: boolean) => void
  className?: string
}

/** Displays new-chat access and recent persisted conversations. */
export function ChatHistory({
  chats,
  activeChatId,
  onSelect,
  onNew,
  onRename,
  onToggleUnread,
  onTogglePin,
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
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        aria-label={`${chat.title}${chat.isUnread ? " (unread)" : ""}${chat.isPinned ? " (pinned)" : ""}`}
                        className={cn(
                          "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-3 text-left text-sm text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          chat.isUnread && "font-medium",
                          selected && "bg-muted hover:bg-muted"
                        )}
                        onClick={() => onSelect(chat.id)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {chat.title}
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {chat.isUnread ? (
                            <span
                              className="size-1.5 rounded-full bg-brand"
                              aria-hidden="true"
                            />
                          ) : null}
                          {chat.isPinned ? (
                            <HugeiconsIcon
                              icon={Pin02Icon}
                              size={15}
                              strokeWidth={1.8}
                              className="text-muted-foreground"
                              aria-hidden="true"
                            />
                          ) : null}
                          {chat.status === "running" ? (
                            <HugeiconsIcon
                              icon={Loading03Icon}
                              size={15}
                              strokeWidth={2}
                              className="animate-spin text-muted-foreground motion-reduce:animate-none"
                              aria-label="Reply in progress"
                            />
                          ) : null}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => onRename(chat.id)}>
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          size={17}
                          aria-hidden="true"
                        />
                        Rename chat
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => onToggleUnread(chat.id, !chat.isUnread)}
                      >
                        <HugeiconsIcon
                          icon={CheckUnread01Icon}
                          size={17}
                          aria-hidden="true"
                        />
                        {chat.isUnread ? "Mark as read" : "Mark as unread"}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => onTogglePin(chat.id, !chat.isPinned)}
                      >
                        <HugeiconsIcon
                          icon={Pin02Icon}
                          size={17}
                          aria-hidden="true"
                        />
                        {chat.isPinned ? "Unpin chat" : "Pin chat"}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="px-3 py-8 text-center text-muted-foreground">
            <HugeiconsIcon
              icon={Chat01Icon}
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
