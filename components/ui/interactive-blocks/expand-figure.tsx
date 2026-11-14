"use client"

/**
 * An "Open larger" button for graphs, visualisations, and diagrams in replies.
 *
 * Replies are a narrow reading column, so a figure there is drawn small. This opens the same figure in a
 * near full-screen dialog, like a canvas beside the conversation, and renders it only while open.
 */
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ExpandIcon } from "@/components/ui/icon"

/**
 * Renders a small icon button that opens `children` in a large dialog.
 * @param title Figure name, used as the dialog title and in the button's accessible name.
 * @param children Larger rendering of the figure; mounted only while the dialog is open.
 * @returns The trigger button with its dialog.
 */
export function ExpandFigureButton({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label={`Open ${title} larger`}
          title="Open larger"
        >
          <ExpandIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex w-[min(1200px,calc(100%-2rem))] flex-col sm:max-w-[min(1200px,calc(100%-2rem))]">
        <div className="pr-10">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            A larger view of this figure.
          </DialogDescription>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
