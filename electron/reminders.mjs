/**
 * Sends the desktop app's daily study reminder: once a day, at or after the
 * learner's chosen hour, if today's XP goal is not met yet, a native
 * notification offers to continue where they left off.
 *
 * The decision is a pure function so it can be tested without Electron or
 * Convex; `startStudyReminders` wires it to a timer, a summary loader, and a
 * notifier supplied by the main process.
 */

/** How often the reminder checks whether it should fire. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

/**
 * @typedef {{
 *   todayXp: number,
 *   goal: number,
 *   streak: { current: number, todayMet: boolean, todayStudied?: boolean },
 *   resume: { projectId: string, unitId: string, unitTitle: string } | null,
 *   reminderHour: number | null,
 * }} ReminderSummary
 */

/**
 * Decides whether to remind now and what to say.
 * @param {{ now: Date, lastRemindedDay: string | undefined, summary: ReminderSummary }} input
 * @returns {{ day: string, title: string, body: string, path: string } | null}
 *   The notification to show, or null when no reminder is due.
 */
export function reminderFor({ now, lastRemindedDay, summary }) {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-")
  if (summary.reminderHour === null) return null
  if (now.getHours() < summary.reminderHour) return null
  if (lastRemindedDay === day || summary.streak.todayMet) return null
  const remaining = Math.max(0, summary.goal - summary.todayXp)
  // Any study keeps the streak, so once today counts the nudge is the goal.
  const title = summary.streak.todayStudied
    ? "Today's goal is in reach"
    : summary.streak.current
      ? `Keep your ${summary.streak.current}-day streak`
      : "Time for today's study"
  const body = summary.resume
    ? `${remaining} XP to go. Continue ${summary.resume.unitTitle}.`
    : `${remaining} XP to go. A few questions will do it.`
  const path = summary.resume
    ? `/projects/${encodeURIComponent(summary.resume.projectId)}/learn/${encodeURIComponent(summary.resume.unitId)}`
    : "/"
  return { day, title, body, path }
}

/**
 * Starts checking for reminders until the returned stop function is called.
 * @param {{
 *   loadSummary: (now: Date) => Promise<ReminderSummary>,
 *   notify: (reminder: { title: string, body: string, path: string }) => void,
 *   intervalMs?: number,
 *   clock?: () => Date,
 *   lastRemindedDay?: string,
 *   onReminded?: (day: string) => void,
 * }} options `lastRemindedDay` and `onReminded` let the caller persist the
 *   last reminder day, so restarting the app does not remind twice in a day.
 * @returns {() => void} Stops further checks.
 */
export function startStudyReminders({
  loadSummary,
  notify,
  intervalMs = CHECK_INTERVAL_MS,
  clock = () => new Date(),
  lastRemindedDay: initialLastRemindedDay,
  onReminded = () => undefined,
}) {
  let lastRemindedDay = initialLastRemindedDay
  let checking = false
  /** Loads today's summary and shows a reminder when one is due. */
  const check = async () => {
    if (checking) return
    checking = true
    try {
      const now = clock()
      const reminder = reminderFor({
        now,
        lastRemindedDay,
        summary: await loadSummary(now),
      })
      if (reminder) {
        lastRemindedDay = reminder.day
        onReminded(reminder.day)
        notify(reminder)
      }
    } catch {
      // Blitz may still be starting or Convex restarting; try at the next check.
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => void check(), intervalMs)
  timer.unref?.()
  void check()
  return () => clearInterval(timer)
}
