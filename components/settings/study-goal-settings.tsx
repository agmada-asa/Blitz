"use client"

/**
 * Lets the learner choose the daily XP goal that keeps their streak going,
 * and when the desktop app reminds them if the goal is not met.
 */

import { useMutation, useQuery } from "convex/react"
import { useState } from "react"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/convex/_generated/api"
import { cn } from "@/lib/utils"

/** Goal presets, described by roughly what each takes. */
const GOALS = [
  { xp: 30, label: "Light", detail: "A few questions" },
  { xp: 50, label: "Regular", detail: "One section and a short drill" },
  { xp: 100, label: "Serious", detail: "Two sections and a drill" },
  { xp: 150, label: "Exam season", detail: "A unit's worth of work" },
] as const

/** Reminder hours offered, as local 24-hour clock hours. */
const REMINDER_HOURS = [16, 17, 18, 19, 20, 21, 22]

/** Select value meaning no reminder. */
const REMINDER_OFF = "off"

/** Renders the daily goal choices and reminder time, saving changes immediately. */
export function StudyGoalSettings() {
  const setting = useQuery(api.progress.dailyGoalSetting, {})
  const save = useMutation(api.progress.setDailyGoal)
  const saveReminder = useMutation(api.progress.setReminderHour)
  const [error, setError] = useState("")
  const current = setting?.xp

  return (
    <div className="space-y-3">
      <RadioGroup
        aria-label="Daily goal"
        // Always controlled: no option is selected until the saved goal loads.
        value={current === undefined ? "" : String(current)}
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
      <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor="study-reminder" className="text-sm">
          <span className="block font-medium">Daily reminder</span>
          <span className="block text-xs text-muted-foreground">
            The desktop app reminds you if your goal is not met by this time.
          </span>
        </label>
        <Select
          value={
            setting === undefined
              ? ""
              : setting.reminderHour === null
                ? REMINDER_OFF
                : String(setting.reminderHour)
          }
          onValueChange={(value) => {
            setError("")
            saveReminder({ hour: value === REMINDER_OFF ? null : Number(value) }).catch(() =>
              setError("The reminder could not be saved. Try again.")
            )
          }}
          disabled={setting === undefined}
        >
          <SelectTrigger id="study-reminder" className="min-h-11 w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={REMINDER_OFF}>Off</SelectItem>
            {REMINDER_HOURS.map((hour) => (
              <SelectItem key={hour} value={String(hour)}>
                {`${String(hour).padStart(2, "0")}:00`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
