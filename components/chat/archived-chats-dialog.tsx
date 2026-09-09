"use client"

/** Modal dialog for browsing, opening, restoring, and permanently deleting archived chats. */

import {
  Archive02Icon,
  ArchiveRestoreIcon,
  Delete02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ElapsedTime } from "@/components/ui/elapsed-time"
import { LoadingIcon } from "@/components/ui/icon"
import type { Id } from "@/convex/_generated/dataModel"

/** Summary of one archived chat displayed in the dialog. */
export type ArchivedChatItem = {
  id: Id<"workspaceChats">
  title: string
  projectId?: Id<"projects">
  projectTitle?: string | null
  updatedAt: number
}

/** Controlled props for the archived chats browser. */
type ArchivedChatsDialogProps = {
  open: boolean
  archivedChats?: ArchivedChatItem[]
  onOpenChange: (open: boolean) => void
  onSelect: (chatId: Id<"workspaceChats">) => void
  onUnarchive: (chatId: Id<"workspaceChats">) => void
  onDelete: (chatId: Id<"workspaceChats">) => void
}

/** Displays archived chats with restore and delete controls. */
export function ArchivedChatsDialog({
  open,
  archivedChats,
  onOpenChange,
  onSelect,
  onUnarchive,
  onDelete,
}: ArchivedChatsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="archived-chats-description"
        className="max-h-[85vh] sm:max-w-lg flex flex-col p-6 overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Archived chats</DialogTitle>
          <DialogDescription id="archived-chats-description">
            Archived chats are hidden from your active list. You can view, restore, or delete them.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto -mx-2 px-2 py-2">
          {archivedChats === undefined ? (
            <div
              className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"
              role="status"
            >
              <LoadingIcon className="size-4 animate-spin motion-reduce:animate-none" />
              Loading archived chats…
            </div>
          ) : archivedChats.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-3">
                <HugeiconsIcon icon={Archive02Icon} size={24} strokeWidth={1.8} />
              </span>
              <p className="text-sm font-medium text-foreground">No archived chats</p>
              <p className="mt-1 text-xs text-muted-foreground max-w-xs">
                Chats you archive will appear here. You can restore them back to your active list at any time.
              </p>
            </div>
          ) : (
            <ul className="space-y-1.5" role="list">
              {archivedChats.map((chat) => (
                <li
                  key={chat.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/60 p-3 transition-colors hover:bg-muted/50"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
                    onClick={() => {
                      onSelect(chat.id)
                      onOpenChange(false)
                    }}
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {chat.title}
                    </span>
                    <div className="mt-1.5 flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="h-4.5 max-w-[180px] truncate px-1.5 py-0 text-[10px] font-normal text-muted-foreground border-border/60"
                      >
                        {chat.projectTitle || "No project"}
                      </Badge>
                      <span className="text-[11px] text-muted-foreground">
                        <ElapsedTime since={chat.updatedAt} />
                      </span>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
                      title="Restore chat"
                      aria-label={`Restore chat ${chat.title}`}
                      onClick={() => onUnarchive(chat.id)}
                    >
                      <HugeiconsIcon
                        icon={ArchiveRestoreIcon}
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      <span className="hidden sm:inline">Restore</span>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete chat permanently"
                      aria-label={`Delete chat ${chat.title}`}
                      onClick={() => onDelete(chat.id)}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        size={15}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
