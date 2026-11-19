"use client"

/**
 * The Export chat dialog: copies the open chat as Markdown or downloads it as
 * a file, with or without the agent's working notes and tool calls. Opened
 * from the chat workspace's chat menu.
 */
import { Copy01Icon, Download01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  chatExportFilename,
  chatMarkdown,
  type ExportableMessage,
} from "@/lib/client/chat-export"

/** The chat being exported. */
type ExportChatProps = {
  title: string | undefined
  messages: readonly ExportableMessage[]
}

/**
 * Shows the export choices while `open`. Each opening starts with agent
 * activity included and no notice.
 */
export function ExportChatDialog({
  open,
  onOpenChange,
  ...chat
}: ExportChatProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="export-chat-description">
        <ExportChatContent {...chat} />
      </DialogContent>
    </Dialog>
  )
}

/** The dialog's body, mounted only while it is open so its choices reset. */
function ExportChatContent({ title, messages }: ExportChatProps) {
  const [includeAgentActivity, setIncludeAgentActivity] = useState(true)
  const [notice, setNotice] = useState("")
  const markdown = () => chatMarkdown(title, messages, includeAgentActivity)

  /** Copies the transcript to the clipboard and reports recoverable errors. */
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown())
      setNotice("Chat copied to clipboard.")
    } catch {
      setNotice("Clipboard access failed. Try downloading the Markdown file.")
    }
  }

  /** Downloads the transcript as a Markdown file. */
  const download = (): void => {
    const blob = new Blob([markdown()], {
      type: "text/markdown;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = chatExportFilename(title)
    anchor.click()
    URL.revokeObjectURL(url)
    setNotice("Markdown file downloaded.")
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Export chat</DialogTitle>
        <DialogDescription id="export-chat-description">
          Export the full conversation as Markdown, including your messages and
          replies.
        </DialogDescription>
      </DialogHeader>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
        <Checkbox
          checked={includeAgentActivity}
          onCheckedChange={(checked) => setIncludeAgentActivity(checked === true)}
          className="mt-0.5"
        />
        <span className="grid gap-1">
          <span className="font-medium">
            Include agent working and tool calls
          </span>
          <span className="text-muted-foreground">
            Adds available working notes, tool activity, and agent requests.
          </span>
        </span>
      </label>
      <p aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
        {notice}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => void copy()}>
          <HugeiconsIcon icon={Copy01Icon} size={15} aria-hidden="true" />
          Copy to clipboard
        </Button>
        <Button type="button" onClick={download}>
          <HugeiconsIcon icon={Download01Icon} size={15} aria-hidden="true" />
          Export as Markdown
        </Button>
      </DialogFooter>
    </>
  )
}
