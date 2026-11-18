/**
 * Groups timestamped lists, such as chat history and notifications, under day headings, and
 * collapses runs of similar neighbouring items. Kept free of React so the rules can be tested
 * directly and shared by every list that shows "Today", "Yesterday", "This week" and "Earlier".
 */

/** The day headings a grouped list can show, newest first. */
export type DayGroupLabel = "Today" | "Yesterday" | "This week" | "Earlier"

/** One heading and the items under it, in their original order. */
export type DayGroup<T> = { label: DayGroupLabel; items: T[] }

/** Milliseconds in one day, used only to step between local midnights. */
const DAY_MS = 86_400_000

/**
 * Returns the local midnight that starts the day holding `timestamp`.
 * @param timestamp Milliseconds since the epoch.
 */
function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Names the day heading for a timestamp relative to `now`, using the viewer's local calendar.
 * "This week" covers the five days before yesterday; anything older is "Earlier". A timestamp
 * in the future counts as today.
 * @param timestamp When the item last changed, in milliseconds.
 * @param now The current time, passed in so tests and renders agree on one clock.
 */
export function dayGroupLabel(timestamp: number, now: number): DayGroupLabel {
  const today = startOfLocalDay(now)
  if (timestamp >= today) return "Today"
  // Step back by calendar day rather than 24 hours so daylight saving changes don't shift items.
  const yesterday = startOfLocalDay(today - DAY_MS / 2)
  if (timestamp >= yesterday) return "Yesterday"
  let weekStart = yesterday
  for (let day = 0; day < 5; day += 1) {
    weekStart = startOfLocalDay(weekStart - DAY_MS / 2)
  }
  return timestamp >= weekStart ? "This week" : "Earlier"
}

/**
 * Splits a list under day headings without reordering it. Items are expected newest first;
 * an item that is out of order joins the group it falls in rather than opening a repeat heading.
 * Empty groups are left out.
 * @param items The list to group, newest first.
 * @param timeOf Reads the timestamp an item is grouped by.
 * @param now The current time.
 */
export function groupByDay<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  now: number
): DayGroup<T>[] {
  const groups = new Map<DayGroupLabel, T[]>()
  for (const item of items) {
    const label = dayGroupLabel(timeOf(item), now)
    const group = groups.get(label)
    if (group) group.push(item)
    else groups.set(label, [item])
  }
  const order: DayGroupLabel[] = ["Today", "Yesterday", "This week", "Earlier"]
  return order.flatMap((label) => {
    const groupItems = groups.get(label)
    return groupItems ? [{ label, items: groupItems }] : []
  })
}

/** A list entry after collapsing: one item on its own, or a run of two or more similar items. */
export type CollapsedEntry<T> =
  { type: "single"; item: T } | { type: "run"; items: T[] }

/**
 * Collapses each run of two or more neighbouring items that share a run key into one entry.
 * Items without a key, and runs of one, stay single. Order is preserved.
 * @param items The list to collapse.
 * @param runKey Returns the key that lets an item join its neighbours, or null to stand alone.
 */
export function collapseRuns<T>(
  items: readonly T[],
  runKey: (item: T) => string | null
): CollapsedEntry<T>[] {
  const entries: CollapsedEntry<T>[] = []
  let run: T[] = []
  let currentKey: string | null = null

  /** Moves the run being built into the output, as a run or a single item. */
  const flush = () => {
    if (run.length === 1) entries.push({ type: "single", item: run[0] })
    else if (run.length > 1) entries.push({ type: "run", items: run })
    run = []
  }

  for (const item of items) {
    const key = runKey(item)
    if (key === null) {
      flush()
      currentKey = null
      entries.push({ type: "single", item })
      continue
    }
    if (key !== currentKey) flush()
    currentKey = key
    run.push(item)
  }
  flush()
  return entries
}
