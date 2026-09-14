"use client"

/** Renders the saved chat rail with view mode toggling, project badges, archiving, and deletion. */

import {
  Add01Icon,
  Archive02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Chat01Icon,
  CheckUnread01Icon,
  Clock01Icon,
  Delete02Icon,
  Folder01Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Pin02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Id } from "@/convex/_generated/dataModel"
import { cn } from "@/lib/utils"

/** Supported layout modes for the saved chats rail. */
export type ChatViewMode = "chronological" | "project"

/** Key used to remember user's chat rail view mode across sessions. */
const VIEW_MODE_STORAGE_KEY = "blitz_chat_view_mode"

/** Summary needed to identify and display one persisted chat. */
export type ChatHistoryItem = {
  id: Id<"workspaceChats">
  projectId?: Id<"projects">
  projectTitle?: string | null
  title: string
  status: "idle" | "running" | "failed"
  isUnread: boolean
  isPinned: boolean
  isArchived?: boolean
  updatedAt: number
}

/** Data and actions shared by the desktop rail and mobile history dialog. */
type ChatHistoryProps = {
  chats?: ChatHistoryItem[]
  activeChatId?: Id<"workspaceChats">
  onSelect: (chatId: Id<"workspaceChats">) => void
  onNew: () => void
  onNewInProject?: (project: { _id: Id<"projects">; title: string }) => void
  onRename: (chatId: Id<"workspaceChats">) => void
  onToggleUnread: (chatId: Id<"workspaceChats">, unread: boolean) => void
  onTogglePin: (chatId: Id<"workspaceChats">, pinned: boolean) => void
  onToggleArchive: (chatId: Id<"workspaceChats">, archived: boolean) => void
  onDelete: (chatId: Id<"workspaceChats">) => void
  onOpenArchived?: () => void
  archivedCount?: number
  className?: string
}

/** Displays new-chat access, view mode toggle, recent conversations, and archive entry. */
export function ChatHistory({
  chats,
  activeChatId,
  onSelect,
  onNew,
  onNewInProject,
  onRename,
  onToggleUnread,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onOpenArchived,
  archivedCount,
  className,
}: ChatHistoryProps) {
  const [viewMode, setViewMode] = useState<ChatViewMode>(() => {
    if (typeof window === "undefined") return "chronological"
    try {
      const saved = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
      if (saved === "chronological" || saved === "project") {
        return saved
      }
    } catch {
      // Ignore localStorage read errors in restricted contexts.
    }
    return "chronological"
  })
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})

  /** Updates view mode and persists preference. */
  const changeViewMode = (mode: ChatViewMode): void => {
    setViewMode(mode)
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode)
    } catch {
      // Ignore localStorage write errors.
    }
  }

  /** Toggles collapsed state for a project group in project-based view. */
  const toggleProjectCollapse = (projectKey: string): void => {
    setCollapsedProjects((prev) => ({
      ...prev,
      [projectKey]: !prev[projectKey],
    }))
  }

  /** Groups chats by project for the project-based view. */
  const projectGroups = useMemo(() => {
    if (!chats) return []
    const groupsMap = new Map<
      string,
      {
        key: string
        projectId?: Id<"projects">
        title: string
        chats: ChatHistoryItem[]
      }
    >()

    for (const chat of chats) {
      const key = chat.projectId ?? "unassigned"
      const existing = groupsMap.get(key)
      if (existing) {
        existing.chats.push(chat)
      } else {
        groupsMap.set(key, {
          key,
          projectId: chat.projectId,
          title: chat.projectTitle || (chat.projectId ? "Project" : "General"),
          chats: [chat],
        })
      }
    }

    // Sort projects alphabetically, keeping unassigned/general at the end.
    return Array.from(groupsMap.values()).sort((a, b) => {
      if (!a.projectId) return 1
      if (!b.projectId) return -1
      return a.title.localeCompare(b.title)
    })
  }, [chats])

  /** Renders context menu and row dropdown menu actions for a chat. */
  const renderChatActions = (chat: ChatHistoryItem) => (
    <>
      <ContextMenuItem onSelect={() => onRename(chat.id)}>
        <HugeiconsIcon icon={PencilEdit02Icon} size={16} aria-hidden="true" />
        Rename chat
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onToggleUnread(chat.id, !chat.isUnread)}>
        <HugeiconsIcon icon={CheckUnread01Icon} size={16} aria-hidden="true" />
        {chat.isUnread ? "Mark as read" : "Mark as unread"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onTogglePin(chat.id, !chat.isPinned)}>
        <HugeiconsIcon icon={Pin02Icon} size={16} aria-hidden="true" />
        {chat.isPinned ? "Unpin chat" : "Pin chat"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => onToggleArchive(chat.id, !chat.isArchived)}>
        <HugeiconsIcon icon={Archive02Icon} size={16} aria-hidden="true" />
        {chat.isArchived ? "Restore chat" : "Archive chat"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => onDelete(chat.id)}
      >
        <HugeiconsIcon icon={Delete02Icon} size={16} aria-hidden="true" />
        Delete chat
      </ContextMenuItem>
    </>
  )

  /** Renders the dropdown menu items for the row options button. */
  const renderDropdownItems = (chat: ChatHistoryItem) => (
    <>
      <DropdownMenuItem onSelect={() => onRename(chat.id)}>
        <HugeiconsIcon icon={PencilEdit02Icon} size={15} aria-hidden="true" />
        Rename chat
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onToggleUnread(chat.id, !chat.isUnread)}>
        <HugeiconsIcon icon={CheckUnread01Icon} size={15} aria-hidden="true" />
        {chat.isUnread ? "Mark as read" : "Mark as unread"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onTogglePin(chat.id, !chat.isPinned)}>
        <HugeiconsIcon icon={Pin02Icon} size={15} aria-hidden="true" />
        {chat.isPinned ? "Unpin chat" : "Pin chat"}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onToggleArchive(chat.id, !chat.isArchived)}>
        <HugeiconsIcon icon={Archive02Icon} size={15} aria-hidden="true" />
        {chat.isArchived ? "Restore chat" : "Archive chat"}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onSelect={() => onDelete(chat.id)}
      >
        <HugeiconsIcon icon={Delete02Icon} size={15} aria-hidden="true" />
        Delete chat
      </DropdownMenuItem>
    </>
  )

  return (
    <div
      className={cn(
        "flex h-full w-full min-w-0 flex-col overflow-hidden",
        className
      )}
    >
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
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

      <div className="px-3 pb-2 shrink-0">
        <div
          role="radiogroup"
          aria-label="Chat view mode"
          className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1 text-xs"
        >
          <button
            type="button"
            role="radio"
            aria-checked={viewMode === "chronological"}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1 font-medium transition-colors",
              viewMode === "chronological"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => changeViewMode("chronological")}
          >
            <HugeiconsIcon icon={Clock01Icon} size={13} strokeWidth={1.8} />
            <span>Recent</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={viewMode === "project"}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md py-1 font-medium transition-colors",
              viewMode === "project"
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            )}
            onClick={() => changeViewMode("project")}
          >
            <HugeiconsIcon icon={Folder01Icon} size={13} strokeWidth={1.8} />
            <span>By project</span>
          </button>
        </div>
      </div>

      <nav
        aria-label="Chat history"
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
      >
        {chats === undefined ? (
          <p role="status" className="px-3 py-4 text-xs text-muted-foreground">
            Loading chats…
          </p>
        ) : chats.length === 0 ? (
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
        ) : viewMode === "chronological" ? (
          /* Chronological view with project badge beneath each chat */
          <ul className="w-full min-w-0 space-y-1" role="list">
            {chats.map((chat) => {
              const selected = chat.id === activeChatId
              return (
                <li key={chat.id} className="group relative min-w-0">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        type="button"
                        aria-current={selected ? "page" : undefined}
                        aria-label={`${chat.title}${chat.projectTitle ? ` (${chat.projectTitle})` : ""}${chat.isUnread ? " (unread)" : ""}${chat.isPinned ? " (pinned)" : ""}`}
                        className={cn(
                          "flex w-full min-w-0 flex-col gap-1 overflow-hidden rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                          chat.isUnread && "font-medium",
                          selected && "bg-muted hover:bg-muted"
                        )}
                        onClick={() => onSelect(chat.id)}
                      >
                        <div className="flex w-full min-w-0 items-center justify-between gap-1.5">
                          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
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
                                size={14}
                                strokeWidth={1.8}
                                className="text-muted-foreground"
                                aria-hidden="true"
                              />
                            ) : null}
                            {chat.status === "running" ? (
                              <HugeiconsIcon
                                icon={Loading03Icon}
                                size={14}
                                strokeWidth={2}
                                className="animate-spin text-muted-foreground motion-reduce:animate-none"
                                aria-label="Reply in progress"
                              />
                            ) : null}
                          </span>
                        </div>
                        <div className="flex items-center">
                          <Badge
                            variant="outline"
                            className="h-4.5 max-w-[190px] truncate px-1.5 py-0 text-[10px] font-normal text-muted-foreground border-border/60"
                          >
                            {chat.projectTitle || "No project"}
                          </Badge>
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      {renderChatActions(chat)}
                    </ContextMenuContent>
                  </ContextMenu>

                  {/* Accessible row menu trigger */}
                  <div className="absolute right-2 bottom-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="size-5 rounded-md text-muted-foreground hover:text-foreground"
                          aria-label={`Options for ${chat.title}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <HugeiconsIcon icon={MoreHorizontalIcon} size={13} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {renderDropdownItems(chat)}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          /* Project-based view with collapsible project sections */
          <div className="space-y-3">
            {projectGroups.map((group) => {
              const isCollapsed = collapsedProjects[group.key] ?? false
              return (
                <div key={group.key} className="space-y-1">
                  <div className="group/project flex items-center justify-between rounded-md pr-1 transition-colors hover:bg-muted/40">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => toggleProjectCollapse(group.key)}
                      aria-expanded={!isCollapsed}
                    >
                      <HugeiconsIcon
                        icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                        size={12}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={14}
                        className="shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{group.title}</span>
                      <span className="shrink-0 rounded-full bg-muted/80 px-1.5 py-0.2 text-[10px] text-muted-foreground">
                        {group.chats.length}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground opacity-60 group-hover/project:opacity-100 focus-visible:opacity-100 transition-opacity"
                      aria-label={`New chat in ${group.title}`}
                      title={`New chat in ${group.title}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (isCollapsed) {
                          toggleProjectCollapse(group.key)
                        }
                        if (group.projectId && onNewInProject) {
                          onNewInProject({ _id: group.projectId, title: group.title })
                        } else {
                          onNew()
                        }
                      }}
                    >
                      <HugeiconsIcon icon={PencilEdit02Icon} size={13} strokeWidth={1.8} />
                    </Button>
                  </div>

                  {!isCollapsed && (
                    <ul className="w-full min-w-0 space-y-1 pl-2 border-l border-border/40 ml-2" role="list">
                      {group.chats.map((chat) => {
                        const selected = chat.id === activeChatId
                        return (
                          <li key={chat.id} className="group relative min-w-0">
                            <ContextMenu>
                              <ContextMenuTrigger asChild>
                                <button
                                  type="button"
                                  aria-current={selected ? "page" : undefined}
                                  aria-label={`${chat.title}${chat.isUnread ? " (unread)" : ""}${chat.isPinned ? " (pinned)" : ""}`}
                                  className={cn(
                                    "flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg px-2.5 text-left text-sm text-foreground transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                                    chat.isUnread && "font-medium",
                                    selected && "bg-muted hover:bg-muted"
                                  )}
                                  onClick={() => onSelect(chat.id)}
                                >
                                  <span className="min-w-0 flex-1 truncate text-xs">
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
                                        size={13}
                                        strokeWidth={1.8}
                                        className="text-muted-foreground"
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                    {chat.status === "running" ? (
                                      <HugeiconsIcon
                                        icon={Loading03Icon}
                                        size={13}
                                        strokeWidth={2}
                                        className="animate-spin text-muted-foreground motion-reduce:animate-none"
                                        aria-label="Reply in progress"
                                      />
                                    ) : null}
                                  </span>
                                </button>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                {renderChatActions(chat)}
                              </ContextMenuContent>
                            </ContextMenu>

                            {/* Accessible row menu trigger */}
                            <div className="absolute right-1 top-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-xs"
                                    className="size-5 rounded-md text-muted-foreground hover:text-foreground"
                                    aria-label={`Options for ${chat.title}`}
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <HugeiconsIcon icon={MoreHorizontalIcon} size={13} />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  {renderDropdownItems(chat)}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </nav>

      {/* Footer: Archived chats entry point */}
      {onOpenArchived && (
        <div className="shrink-0 border-t border-border/50 p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onOpenArchived}
          >
            <HugeiconsIcon icon={Archive02Icon} size={15} strokeWidth={1.8} />
            <span>Archived chats</span>
            {archivedCount !== undefined && archivedCount > 0 ? (
              <span className="ml-auto rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-medium text-muted-foreground">
                {archivedCount}
              </span>
            ) : null}
          </Button>
        </div>
      )}
    </div>
  )
}
