/**
 * @file ocean-app/src/screens/today.tsx
 * @description The start screen, matching the Library's Today panel: XP against the daily goal
 * and the streak, the lesson to continue, concepts due for review, and the modules studied most
 * recently.
 */

import * as React from "react"
import { Button } from "@/components/ui/button"
import { openLink, setContext } from "../bridge"
import { go, teachUrl, useTool, type Home } from "../data"
import { Bar, List, Row, Section, Status } from "../ui"

/** How many recently studied modules the screen lists. */
const RECENT_MODULES = 3

/** Short weekday initial for a `YYYY-MM-DD` day key. */
function weekday(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString("en-GB", {
    weekday: "narrow",
  })
}

/**
 * The last seven days' XP as small bars, today last.
 *
 * @param props.week Each day's XP, oldest first.
 * @param props.goal The daily goal, drawn as a full bar.
 */
function Week({ week, goal }: { week: Home["today"]["week"]; goal: number }) {
  return (
    <div
      className="mt-4 flex items-end gap-2"
      aria-label="XP over the last seven days"
    >
      {week.map((entry, index) => (
        <div
          key={entry.day}
          className="flex flex-1 flex-col items-center gap-1"
          title={`${entry.xp} XP`}
        >
          <div className="flex h-10 w-full items-end overflow-hidden rounded-md bg-muted">
            <div
              className={
                entry.xp >= goal ? "w-full bg-brand" : "w-full bg-brand/40"
              }
              style={{
                height: `${goal ? Math.min(100, (entry.xp / goal) * 100) : 0}%`,
              }}
            />
          </div>
          <span
            className={
              index === week.length - 1
                ? "text-[11px] font-medium"
                : "text-[11px] text-muted-foreground"
            }
          >
            {weekday(entry.day)}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Shows today's progress and what to do next. */
export function Today() {
  const home = useTool<Home>("app_home")
  const data = home.data

  React.useEffect(() => {
    setContext(
      "Blitz's Today screen (XP, streak, the lesson to continue and concepts due)."
    )
  }, [])

  if (!data)
    return (
      <Status loading={home.loading} error={home.error} onRetry={home.reload} />
    )

  const { today } = data
  const recent = data.modules
    .filter((item) => item.lastStudiedAt)
    .slice(0, RECENT_MODULES)

  return (
    <>
      <section className="px-5 pt-5 pb-4">
        <p className="text-[13px] text-muted-foreground">
          {today.streak
            ? `${today.streak}-day streak${today.goalMet ? ", today's goal met" : ""}`
            : "Start a streak by meeting today's goal"}
        </p>
        <p className="mt-1 text-[34px] leading-none font-semibold tracking-[-0.03em]">
          {today.xp}
          <span className="text-[17px] font-medium text-muted-foreground">
            {" "}
            / {today.goal} XP
          </span>
        </p>
        <Bar
          value={today.goal ? today.xp / today.goal : 0}
          className="mt-3 h-1.5"
        />
        <p className="mt-2 text-[13px] text-muted-foreground">
          {today.answered} question{today.answered === 1 ? "" : "s"} answered,{" "}
          {today.sections} section{today.sections === 1 ? "" : "s"} taught today
        </p>
        <Week week={today.week} goal={today.goal} />
      </section>

      {today.resume ? (
        <section className="mx-5 my-2 rounded-2xl border border-border bg-card p-4">
          <p className="text-xs font-medium text-brand">Continue</p>
          <p className="mt-1 text-[16px] leading-snug font-semibold">
            {today.resume.unitTitle}
          </p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {today.resume.moduleTitle} · {today.resume.detail}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="lg"
              className="bg-brand px-4 text-brand-foreground hover:bg-brand/85"
              onClick={() =>
                openLink(
                  teachUrl(data.links, today.resume!.module, today.resume!.unit)
                )
              }
            >
              Continue in Blitz
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="px-4"
              onClick={() => go("module", today.resume!.module)}
            >
              Open module
            </Button>
          </div>
        </section>
      ) : null}

      <section className="mx-5 my-2 rounded-2xl border border-border bg-card p-4">
        <p className="text-[16px] font-semibold">
          {today.due
            ? `${today.due} concept${today.due === 1 ? "" : "s"} due for review`
            : "Nothing due for review"}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          {today.due
            ? "Questions on what hasn't stuck yet come first."
            : "Review still has questions from units you've started."}
        </p>
        <Button
          size="lg"
          variant={today.due ? "default" : "outline"}
          className="mt-3 px-4"
          onClick={() => go("review")}
        >
          Start review
        </Button>
      </section>

      {recent.length ? (
        <Section title="Recently studied">
          <List>
            {recent.map((item) => (
              <Row
                key={item.id}
                title={item.title}
                meta={`${Math.round(item.progress * 100)}%`}
                detail={item.next ? `Next: ${item.next}` : undefined}
                progress={item.progress}
                onOpen={() => go("module", item.id)}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </>
  )
}
