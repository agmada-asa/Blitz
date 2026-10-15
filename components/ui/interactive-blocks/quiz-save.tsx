"use client"

/**
 * Offers to save a chat quiz to one of the module's units, so it joins that
 * unit's question bank for drills and the Review feed. Shown under quizzes in
 * chat replies when the chat belongs to a module; once saved, it links to
 * Practice instead.
 */
import Link from "next/link"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AddIcon, CheckCircleIcon, LoadingIcon } from "@/components/ui/icon"
import type { QuizSaving } from "@/components/ui/interactive-blocks/context"

/**
 * Renders the save action for one quiz.
 * @param quizId The quiz's id within its message.
 * @param saving Units, saved state, and the save handler from the chat.
 */
export function QuizSaveAction({
  quizId,
  saving,
}: {
  quizId: string
  saving: QuizSaving
}) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle")
  const saved = saving.saved[quizId]
  // The suggested unit comes first; the rest keep module order.
  const units = [
    ...saving.units.filter((unit) => unit.id === saving.defaultUnitId),
    ...saving.units.filter((unit) => unit.id !== saving.defaultUnitId),
  ]

  /** Saves the quiz to a unit and keeps failures retryable. */
  async function save(unitId: string) {
    setStatus("saving")
    try {
      await saving.onSave([quizId], unitId)
      setStatus("idle")
    } catch {
      setStatus("error")
    }
  }

  if (saved)
    return (
      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <CheckCircleIcon size={14} aria-hidden="true" className="text-emerald-700 dark:text-emerald-300" />
        Saved to {saved.unitTitle || "practice"}
        <Link
          href={`/projects/${encodeURIComponent(saving.projectId)}/practice`}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Open Practice
        </Link>
      </p>
    )

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-9 text-muted-foreground hover:text-foreground"
            disabled={status === "saving"}
          >
            {status === "saving" ? (
              <LoadingIcon className="animate-spin" aria-hidden="true" />
            ) : (
              <AddIcon aria-hidden="true" />
            )}
            {status === "saving" ? "Saving…" : "Save to practice"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-w-80">
          <DropdownMenuLabel>Add to a unit&apos;s questions</DropdownMenuLabel>
          {units.map((unit) => (
            <DropdownMenuItem key={unit.id} onSelect={() => void save(unit.id)}>
              <span className="truncate">{unit.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {status === "error" ? (
        <p role="alert" className="text-xs text-destructive">
          The question couldn&apos;t be saved. Try again.
        </p>
      ) : null}
    </div>
  )
}
