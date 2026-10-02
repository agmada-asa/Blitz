"use client"

/** Hosts source citations, card chats, and passage chats in one responsive side panel. */

import { useSyncExternalStore } from "react"

import {
  ChatWorkspace,
  type ChatPassage,
} from "@/components/chat/chat-workspace"
import {
  SourceReader,
  type LearningSourceSelection,
  type SourceSelection,
} from "@/components/chat/source-pane"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { CancelIcon } from "@/components/ui/icon"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import type { Id } from "@/convex/_generated/dataModel"

/** Identifies which learning tool is visible in the side panel. */
export type LearningSidePaneTab = "source" | "chat"

/** Supplies the card and source context for a new learning chat. */
export type LearningChatCard = {
  /** Convex identity of the learning card attached to the new chat. */
  id: Id<"learningItems">
  /** Convex identity of the project that owns the learning card. */
  projectId: Id<"projects">
  /** Card title shown in the chat context and assistant greeting. */
  title: string
  /** Comma separated source names used to ground the chat context. */
  sourceLabel: string
}

/** Accepts either a learning path source reference or a chat citation. */
export type LearningPanelSelection =
  | LearningSourceSelection
  | SourceSelection

/** Props keep tab selection and panel lifetime owned by the surrounding study page. */
type LearningSidePaneProps = {
  /** Citation currently shown in the Source tab, when one is open. */
  sourceSelection?: LearningPanelSelection
  /** Whether the Ask Blitz tab is open. */
  chatOpen: boolean
  /** Current card context for the Ask Blitz tab. */
  chatCard?: LearningChatCard
  /** Selected transcript context for a listening room chat. */
  chatPassage?: ChatPassage
  /** Selected side panel tab. */
  activeTab: LearningSidePaneTab
  /** Changes the selected side panel tab. */
  onTabChange: (tab: LearningSidePaneTab) => void
  /** Closes the selected tab while keeping other open tabs available. */
  onCloseTab: () => void
  /** Closes every tab when the mobile dialog is dismissed. */
  onClose: () => void
  /** Opens chat citations in the Source tab. */
  onOpenSource: (selection: SourceSelection) => void
}

/** Subscribes to the desktop breakpoint used by the learning workspace. */
function subscribeDesktop(callback: () => void): () => void {
  const media = window.matchMedia("(min-width: 1024px)")
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}

/** Reads whether the viewport can display a persistent side panel. */
function getDesktopSnapshot(): boolean {
  return window.matchMedia("(min-width: 1024px)").matches
}

/** Keeps the initial render in the mobile-safe layout until the client loads. */
function getServerSnapshot(): boolean {
  return false
}

/** Displays source citations and card or passage chats in desktop tabs or a full-screen mobile panel. */
export function LearningSidePane({
  sourceSelection,
  chatOpen,
  chatCard,
  chatPassage,
  activeTab,
  onTabChange,
  onCloseTab,
  onClose,
  onOpenSource,
}: LearningSidePaneProps) {
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    getDesktopSnapshot,
    getServerSnapshot
  )
  const tabs = (
    <Tabs
      value={activeTab}
      onValueChange={(value) => onTabChange(value as LearningSidePaneTab)}
      className="flex min-h-0 flex-1 gap-0"
    >
      <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b px-3">
        <TabsList className="h-9 w-auto justify-start">
          {sourceSelection ? (
            <TabsTrigger value="source">Source</TabsTrigger>
          ) : null}
          {chatOpen ? <TabsTrigger value="chat">Ask Blitz</TabsTrigger> : null}
        </TabsList>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1.5 px-2 text-muted-foreground"
          onClick={onCloseTab}
        >
          <CancelIcon size={15} aria-hidden="true" />
          Close {activeTab === "source" ? "source" : "Ask Blitz"}
        </Button>
      </header>
      {sourceSelection ? (
        <TabsContent
          value="source"
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <SourceReader
            key={
              "kind" in sourceSelection
                ? `${sourceSelection.sourceId}:${sourceSelection.locator ?? "source"}`
                : `${sourceSelection.messageId}:${sourceSelection.citationId}`
            }
            selection={sourceSelection}
          />
        </TabsContent>
      ) : null}
      {chatOpen && (chatCard || chatPassage) ? (
        <TabsContent
          value="chat"
          forceMount
          className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden data-[state=inactive]:hidden"
        >
          <ChatWorkspace
            key={chatCard?.id ?? chatPassage?.id}
            initialCard={chatCard}
            initialPassage={chatPassage}
            embedded
            onOpenSource={onOpenSource}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  )

  if (!desktop)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="inset-0 h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">Learning tools</DialogTitle>
          {tabs}
        </DialogContent>
      </Dialog>
    )

  return (
    <aside
      aria-label="Learning side panel"
      className="flex h-full min-h-0 min-w-0 flex-col border-l bg-background"
    >
      {tabs}
    </aside>
  )
}
