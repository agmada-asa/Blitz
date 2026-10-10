"use client"

/** Lets the learner choose the daily XP goal that keeps their streak going. */

import { useMutation, useQuery } from "convex/react"
import { useState } from "react"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"

/** Goal presets, described by roughly what each takes. */
const GOALS = [
  { xp: 30, label: "Light", detail: "A few questions" },
  { xp: 50, label: "Regular", detail: "One section and a short drill" },
  { xp: 100, label: "Serious", detail: "Two sections and a drill" },
  { xp: 150, label: "Exam season", detail: "A unit's worth of work" },
] as const

/** Renders the daily goal choices and saves a change immediately. */
export function StudyGoalSettings() {
  const setting = useQuery(api.progress.dailyGoalSetting, {})
  const save = useMutation(api.progress.setDailyGoal)
  const [error, setError] = useState("")
  const current = setting?.xp

  return (
    <div className="space-y-3">
      <RadioGroup
        aria-label="Daily goal"
        value={current === undefined ? undefined : String(current)}
        onValueChange={(value) => {
          setError("")
          save({ xp: Number(value) }).catch(() => setError("The goal could not be saved. Try again."))
        }}
        className="grid gap-2 sm:grid-cols-2"
        disabled={current === undefined}
      >
        {GOALS.map((goal) => (
          <label
            key={goal.xp}
            className={cn(
              "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/50",
              current === goal.xp && "border-brand/60 bg-brand/[0.06]"
            )}
          >
            <RadioGroupItem value={String(goal.xp)} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">
                {goal.label} · {goal.xp} XP
              </span>
              <span className="block text-xs text-muted-foreground">{goal.detail}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
