"use client"

/**
 * Renaming, pinning, archiving, marking unread and deleting saved chats, from
 * the chat history or the open chat's menu. `useChatManagement` owns the state
 * and the Convex calls; `ChatManagementDialogs` draws the rename and delete
 * dialogs that go with it. Used by the chat workspace.
 */
import { useMutation } from "convex/react"
import { useState, type RefObject } from "react"

import type { ChatHistoryItem } from "@/components/chat/chat-history"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { messageForError } from "@/lib/utils"

/** What the workspace tells chat management about the chats it shows. */
type ChatManagementOptions = {
  /** Chats in history; only these can be renamed. */
  chats: ChatHistoryItem[] | undefined
  /** Archived chats, which can still be deleted or unarchived. */
  archivedChats: ChatHistoryItem[] | undefined
  /** The chat on screen, so deleting it can clear the view. */
  activeChatId: Id<"workspaceChats"> | undefined
  /**
   * The chat the learner marked unread themselves, which the workspace must
   * not mark read again just because it is open.
   */
  manuallyMarkedUnreadRef: RefObject<Id<"workspaceChats"> | undefined>
  /** Shows an error in the workspace when a change fails. */
  onError: (message: string) => void
  /** Called after the chat on screen was deleted. */
  onActiveChatDeleted: () => void
}

/** State and actions returned by {@link useChatManagement}. */
export type ChatManagement = ReturnType<typeof useChatManagement>

/**
 * Manages saved chats: opening the rename and delete dialogs, and changing a
 * chat's unread, pinned and archived state.
 *
 * @returns Actions for menus, plus the state {@link ChatManagementDialogs} needs.
 */
export function useChatManagement({
  chats,
  archivedChats,
  activeChatId,
  manuallyMarkedUnreadRef,
  onError,
  onActiveChatDeleted,
}: ChatManagementOptions) {
  const renameChat = useMutation(api.workspaceChats.rename)
  const setChatUnread = useMutation(api.workspaceChats.setUnread)
  const setChatPinned = useMutation(api.workspaceChats.setPinned)
  const setChatArchived = useMutation(api.workspaceChats.setArchived)
  const deleteChat = useMutation(api.workspaceChats.remove)
  const [renameChatId, setRenameChatId] = useState<Id<"workspaceChats">>()
  const [renameDraft, setRenameDraft] = useState("")
  const [deleteChatId, setDeleteChatId] = useState<Id<"workspaceChats">>()
  const [deletingChat, setDeletingChat] = useState(false)
  const [renamePending, setRenamePending] = useState(false)
  const [renameError, setRenameError] = useState("")

  /** Finds a chat in history or the archive by id. */
  const findChat = (chatId: Id<"workspaceChats"> | undefined) =>
    chats?.find((chat) => chat.id === chatId) ??
    archivedChats?.find((chat) => chat.id === chatId)

  /** Opens the rename form with the current title from chat history. */
  const openRename = (chatId: Id<"workspaceChats">): void => {
    const chat = chats?.find((item) => item.id === chatId)
    if (!chat) return
    setRenameChatId(chatId)
    setRenameDraft(chat.title)
    setRenameError("")
  }

  /** Closes the rename form unless a save is in progress. */
  const closeRename = (): void => {
    if (renamePending) return
    setRenameChatId(undefined)
    setRenameError("")
  }

  /** Saves the new chat title and leaves the dialog open when validation fails. */
  const saveName = async (): Promise<void> => {
    if (!renameChatId || renamePending) return
    const title = renameDraft.trim()
    if (!title) {
      setRenameError("Enter a chat name.")
      return
    }
    setRenamePending(true)
    setRenameError("")
    try {
      await renameChat({ chatId: renameChatId, title })
      setRenameChatId(undefined)
    } catch (cause) {
      setRenameError(messageForError(cause, "This chat could not be renamed."))
    } finally {
      setRenamePending(false)
    }
  }

  /** Changes a chat's unread marker from its context menu. */
  const toggleUnread = (chatId: Id<"workspaceChats">, unread: boolean): void => {
    if (unread) {
      manuallyMarkedUnreadRef.current = chatId
    } else if (manuallyMarkedUnreadRef.current === chatId) {
      manuallyMarkedUnreadRef.current = undefined
    }
    void setChatUnread({ chatId, unread }).catch((cause) => {
      onError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Changes a chat's pinned state from its context menu. */
  const togglePinned = (chatId: Id<"workspaceChats">, pinned: boolean): void => {
    void setChatPinned({ chatId, pinned }).catch((cause) => {
      onError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Changes a chat's archive state from its context menu or actions menu. */
  const toggleArchived = (
    chatId: Id<"workspaceChats">,
    archived: boolean
  ): void => {
    void setChatArchived({ chatId, archived }).catch((cause) => {
      onError(messageForError(cause, "This chat could not be updated."))
    })
  }

  /** Asks to confirm deleting a chat. */
  const requestDelete = (chatId: Id<"workspaceChats">): void =>
    setDeleteChatId(chatId)

  /** Closes the delete confirmation unless the deletion is in progress. */
  const closeDelete = (): void => {
    if (!deletingChat) setDeleteChatId(undefined)
  }

  /** Permanently removes the chat being confirmed and its dependencies. */
  const confirmDelete = async (): Promise<void> => {
    if (!deleteChatId || deletingChat) return
    setDeletingChat(true)
    try {
      const targetId = deleteChatId
      await deleteChat({ chatId: targetId })
      setDeleteChatId(undefined)
      if (activeChatId === targetId) onActiveChatDeleted()
    } catch (cause) {
      onError(messageForError(cause, "This chat could not be deleted."))
    } finally {
      setDeletingChat(false)
    }
  }

  return {
    openRename,
    toggleUnread,
    togglePinned,
    toggleArchived,
    requestDelete,
    rename: {
      open: renameChatId !== undefined,
      draft: renameDraft,
      setDraft: setRenameDraft,
      currentTitle: findChat(renameChatId)?.title,
      pending: renamePending,
      error: renameError,
      close: closeRename,
      save: saveName,
    },
    deletion: {
      open: deleteChatId !== undefined,
      title: findChat(deleteChatId)?.title,
      pending: deletingChat,
      close: closeDelete,
      confirm: confirmDelete,
    },
  }
}

/**
 * Draws the rename and delete dialogs for {@link useChatManagement}.
 *
 * @param management - The state and actions from the hook.
 */
export function ChatManagementDialogs({
  management: { rename, deletion },
}: {
  management: ChatManagement
}) {
  return (
    <>
      <Dialog
        open={rename.open}
        onOpenChange={(open) => {
          if (!open) rename.close()
        }}
      >
        <DialogContent
          aria-describedby="rename-chat-description"
          showCloseButton={!rename.pending}
        >
          <DialogHeader>
            <DialogTitle>Rename chat</DialogTitle>
            <DialogDescription id="rename-chat-description">
              Choose a name that will be easy to find later.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void rename.save()
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="rename-chat">Chat name</Label>
              <Input
                id="rename-chat"
                autoFocus
                maxLength={64}
                value={rename.draft}
                disabled={rename.pending}
                onChange={(event) => rename.setDraft(event.target.value)}
              />
            </div>
            {rename.error ? (
              <p role="alert" className="text-sm text-destructive">
                {rename.error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={rename.pending}
                onClick={rename.close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11"
                disabled={
                  rename.pending ||
                  !rename.draft.trim() ||
                  rename.draft.trim() === rename.currentTitle
                }
              >
                {rename.pending ? "Saving…" : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deletion.open}
        onOpenChange={(open) => {
          if (!open) deletion.close()
        }}
      >
        <DialogContent
          aria-describedby="delete-chat-description"
          showCloseButton={!deletion.pending}
        >
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription id="delete-chat-description">
              {deletion.title
                ? `This permanently deletes “${deletion.title}” and its messages. This cannot be undone.`
                : "This permanently deletes this chat and its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={deletion.pending}
              onClick={deletion.close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-11"
              disabled={deletion.pending}
              onClick={() => void deletion.confirm()}
            >
              {deletion.pending ? "Deleting…" : "Delete chat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
