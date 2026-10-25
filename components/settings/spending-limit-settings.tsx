"use client"

/**
 * Spending limits for background tasks while Claude Code is signed in with an
 * API key. Shown inside Provider connections under the Claude Code row, and
 * only when that sign-in bills per token; a subscription never sees it. The
 * limits are enforced per background turn by Claude Code itself, through the
 * server in `lib/server/spending-limits.ts`.
 */

import { useMutation, useQuery } from "convex/react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/convex/_generated/api"
import {
  TASK_STEPS_RANGE,
  TASK_USD_RANGE,
  validateSpendingLimits,
} from "@/lib/spending-limits"

/** Form for the per-task dollar and step limits, saved together. */
export function SpendingLimitSettings() {
  const saved = useQuery(api.settings.spendingLimits)
  const save = useMutation(api.settings.saveSpendingLimits)
  // Drafts stay empty until edited, so the inputs show the saved values.
  const [usdDraft, setUsdDraft] = useState<string | null>(null)
  const [stepsDraft, setStepsDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success"
    message: string
  } | null>(null)
  const usd = usdDraft ?? (saved ? saved.maxTaskUsd.toFixed(2) : "")
  const steps = stepsDraft ?? (saved ? String(saved.maxTaskSteps) : "")
  const changed = usdDraft !== null || stepsDraft !== null

  /** Validates and saves both limits, then shows the saved values. */
  async function saveLimits() {
    setFeedback(null)
    let limits
    try {
      limits = validateSpendingLimits({
        maxTaskUsd: Number(usd),
        maxTaskSteps: Number(steps),
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        message: error instanceof Error ? error.message : "Check the limits.",
      })
      return
    }
    setBusy(true)
    try {
      await save(limits)
      setUsdDraft(null)
      setStepsDraft(null)
      setFeedback({ tone: "success", message: "Spending limits saved." })
    } catch {
      setFeedback({
        tone: "error",
        message: "The limits could not be saved. Try again.",
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="spending-limit-title"
      className="space-y-4 px-4 py-5"
    >
      <div>
        <h3 id="spending-limit-title" className="text-sm font-medium">
          Spending limit
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Claude Code is on an API key, so mock exams, question banks and
          podcasts cost money per run. A task that goes over these limits is
          stopped.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label
            htmlFor="spending-limit-usd"
            className="block text-sm font-medium"
          >
            Most one task can spend
          </label>
          <p
            id="spending-limit-usd-help"
            className="text-xs text-muted-foreground"
          >
            Applies to background tasks, not your chats
          </p>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-sm text-muted-foreground">
              $
            </span>
            <Input
              id="spending-limit-usd"
              type="number"
              inputMode="decimal"
              min={TASK_USD_RANGE.min}
              max={TASK_USD_RANGE.max}
              step={0.5}
              value={usd}
              disabled={saved === undefined || busy}
              aria-describedby="spending-limit-usd-help"
              className="max-w-32"
              onChange={(event) => setUsdDraft(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="spending-limit-steps"
            className="block text-sm font-medium"
          >
            Most steps per task
          </label>
          <p
            id="spending-limit-steps-help"
            className="text-xs text-muted-foreground"
          >
            Stops a task that keeps going round in circles
          </p>
          <Input
            id="spending-limit-steps"
            type="number"
            inputMode="numeric"
            min={TASK_STEPS_RANGE.min}
            max={TASK_STEPS_RANGE.max}
            step={1}
            value={steps}
            disabled={saved === undefined || busy}
            aria-describedby="spending-limit-steps-help"
            className="max-w-32"
            onChange={(event) => setStepsDraft(event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p
          aria-live="polite"
          className={`text-sm ${feedback?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {feedback?.message ??
            "Codex and OpenCode can't enforce a limit, so this applies to Claude Code only."}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!changed || busy || saved === undefined}
          onClick={() => void saveLimits()}
        >
          {busy ? "Saving" : "Save limits"}
        </Button>
      </div>
    </section>
  )
}
