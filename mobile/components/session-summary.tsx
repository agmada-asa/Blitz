/**
 * What a Teach sitting or a drill added up to, matching the desktop session
 * summary: XP earned, sections taught, accuracy, time spent, each concept
 * answered with its strength, and today's goal and streak. Loaded from
 * `/api/mobile/summary`; the caller supplies the actions.
 */

import { useEffect, useState, type ReactNode } from "react"
import { ActivityIndicator, StyleSheet, View } from "react-native"

import type { MobileSessionSummary } from "../../lib/learning/mobile-contracts"
import { fetchSummary } from "../lib/learning-api"
import { colors, radius } from "../lib/theme"
import { STRENGTH_STYLE } from "./module-screen"
import { Text } from "./native-text"

/** Props for a session summary. */
export type SessionSummaryProps = {
  readonly serverUrl: string
  readonly projectId: string
  readonly unitId?: string
  /** When the session started, in milliseconds. */
  readonly since: number
  /** Small label above the title, for example "Drill complete". */
  readonly eyebrow: string
  /** Shown under the stats, for example the missed questions. */
  readonly children?: ReactNode
  /** The buttons that end the summary. */
  readonly actions: ReactNode
}

/** Formats a duration as "12 min" or "1 h 5 min". */
function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Renders the summary, or a short message when it cannot load. */
export function SessionSummary({ serverUrl, projectId, unitId, since, eyebrow, children, actions }: SessionSummaryProps) {
  const [summary, setSummary] = useState<MobileSessionSummary>()
  const [failed, setFailed] = useState(false)
  // Time is measured when the summary opens, not while it is on screen.
  const [elapsed] = useState(() => Date.now() - since)

  useEffect(() => {
    let cancelled = false
    fetchSummary(serverUrl, { projectId, ...(unitId ? { unitId } : {}), since })
      .then((value) => !cancelled && setSummary(value))
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
    }
  }, [serverUrl, projectId, unitId, since])

  const accuracy = summary?.answered ? Math.round((summary.correct / summary.answered) * 100) : null
  const title = !summary
    ? ""
    : summary.answered || summary.sections
      ? `+${summary.xp} XP`
      : "No answers yet this session"

  return (
    <View style={styles.root}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      {!summary ? (
        failed ? (
          <Text style={styles.muted}>The summary needs a connection to Blitz. Your answers are saved.</Text>
        ) : (
          <ActivityIndicator color={colors.brand} style={styles.loading} />
        )
      ) : (
        <>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <View style={styles.stats}>
            <Stat label="XP earned" value={String(summary.xp)} />
            <Stat label={summary.sections === 1 ? "Section" : "Sections"} value={String(summary.sections)} />
            <Stat label="Correct" value={accuracy === null ? "–" : `${accuracy}%`} />
            <Stat label="Time" value={duration(elapsed)} />
          </View>

          <View style={styles.today}>
            <View style={styles.row}>
              <Text style={styles.label}>Today</Text>
              <Text style={styles.muted}>
                {summary.today.xp} / {summary.today.goal} XP
              </Text>
            </View>
            <View style={styles.track}>
              <View
                style={[styles.fill, { width: `${Math.min(100, (summary.today.xp / summary.today.goal) * 100)}%` }]}
              />
            </View>
            <Text style={styles.muted}>
              {summary.today.streak.todayMet
                ? `Daily goal met · ${summary.today.streak.current}-day streak`
                : `${summary.today.goal - summary.today.xp} XP to keep your streak`}
            </Text>
          </View>

          {summary.concepts.length ? (
            <View style={styles.concepts}>
              <Text style={styles.label}>Concepts</Text>
              {summary.concepts.map((concept) => (
                <View key={concept.conceptId} style={styles.concept}>
                  <View style={[styles.dot, { backgroundColor: STRENGTH_STYLE[concept.strength].color }]} />
                  <Text numberOfLines={1} style={styles.conceptTitle}>
                    {concept.title}
                  </Text>
                  <Text style={styles.muted}>
                    {concept.correct}/{concept.answered}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </>
      )}
      {children}
      <View style={styles.actions}>{actions}</View>
    </View>
  )
}

/** One stat tile. */
function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View accessibilityLabel={`${label}: ${value}`} style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.muted}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: 14 },
  eyebrow: { color: colors.brand, fontSize: 13, fontWeight: "600" },
  title: { color: colors.foreground, fontSize: 30, fontWeight: "600", letterSpacing: -0.8 },
  loading: { marginVertical: 30 },
  muted: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  label: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stat: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexBasis: "47%",
    flexGrow: 1,
    gap: 2,
    padding: 12,
  },
  statValue: { color: colors.foreground, fontSize: 22, fontWeight: "600" },
  today: { gap: 6 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  track: { backgroundColor: colors.muted, borderRadius: 999, height: 8, overflow: "hidden" },
  fill: { backgroundColor: colors.brand, borderRadius: 999, height: "100%" },
  concepts: { gap: 8 },
  concept: { alignItems: "center", flexDirection: "row", gap: 10 },
  dot: { borderRadius: 999, height: 8, width: 8 },
  conceptTitle: { color: colors.text, flex: 1, fontSize: 14 },
  actions: { gap: 10, marginTop: 6 },
})
