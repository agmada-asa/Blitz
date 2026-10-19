/**
 * The first page of Home on the phone, matching the web Today card: the
 * streak, today's XP against the daily goal, the last seven days, and one
 * action to continue the unit being learned. Questions follow it in the feed.
 *
 * It loads `/api/mobile/home` and keeps the last copy on the device, so the
 * page still shows the streak and the unit to resume when offline.
 */

import { useEffect, useState } from "react"
import { Pressable, StyleSheet, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import type { MobileHomeResponse } from "../../lib/learning/mobile-contracts"
import { fetchHome } from "../lib/learning-api"
import { loadCached, saveCached } from "../lib/offline-cache"
import { brandAlpha, colors, radius, TOUCH_TARGET } from "../lib/theme"
import { Text } from "./native-text"
import { SegmentedBar, pathSegments, sectionStates } from "./progress-path"

/** Props for the Today page. */
export type TodayPageProps = {
  readonly serverUrl: string
  /** Changes when the feed refreshes, so the page refreshes with it. */
  readonly refreshToken: number
  /** Whether there are questions below to swipe to. */
  readonly hasCards: boolean
  readonly onContinue: (projectId: string, unitId: string) => void
  readonly onOpenLibrary: () => void
}

/** Formats a `YYYY-MM-DD` key as a weekday name. */
function weekday(day: string, style: "narrow" | "long"): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: style, timeZone: "UTC" })
}

/** Renders the Today page, from the server when reachable, else from the device. */
export function TodayPage({ serverUrl, refreshToken, hasCards, onContinue, onOpenLibrary }: TodayPageProps) {
  const insets = useSafeAreaInsets()
  const [summary, setSummary] = useState<MobileHomeResponse>()
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await loadCached<MobileHomeResponse>(serverUrl, "home")
      if (!cancelled && cached) setSummary((current) => current ?? cached.value)
      try {
        const fresh = await fetchHome(serverUrl)
        if (cancelled) return
        setSummary(fresh)
        setOffline(false)
        await saveCached(serverUrl, "home", fresh)
      } catch {
        if (!cancelled) setOffline(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverUrl, refreshToken])

  if (!summary)
    return (
      <View style={[styles.page, { paddingTop: 96 + insets.top }]}>
        <Text style={styles.muted}>{offline ? "Connect to Blitz to see today's progress." : "Loading today…"}</Text>
      </View>
    )

  const met = summary.streak.todayMet
  const resume = summary.resume
  const ceiling = Math.max(summary.goal, ...summary.week.map((entry) => entry.xp), 1)

  return (
    <View style={[styles.page, { paddingTop: 88 + insets.top, paddingBottom: 96 + insets.bottom }]}>
      <Text style={styles.muted}>{weekday(summary.today, "long")}</Text>
      <Text accessibilityRole="header" style={styles.streak}>
        <Text style={{ color: summary.streak.current ? colors.brand : colors.faint }}>ϟ </Text>
        {summary.streak.current ? `${summary.streak.current}-day streak` : "Start a streak today"}
      </Text>

      <View style={styles.goal}>
        <View style={styles.goalHeader}>
          <Text style={styles.goalLabel}>Today</Text>
          <Text style={styles.muted}>
            {summary.todayXp} / {summary.goal} XP
          </Text>
        </View>
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`${summary.todayXp} of ${summary.goal} XP today`}
          accessibilityValue={{ min: 0, max: summary.goal, now: Math.min(summary.goal, summary.todayXp) }}
          style={styles.track}
        >
          <View style={[styles.trackFill, { width: `${Math.min(100, (summary.todayXp / summary.goal) * 100)}%` }]} />
        </View>
        <Text style={styles.small}>
          {met
            ? "Daily goal met. Anything more is extra."
            : `${summary.goal - summary.todayXp} XP to keep your streak. A taught section is 25 XP, a correct answer 10.`}
        </Text>
      </View>

      <View accessibilityLabel="XP over the last seven days" style={styles.week}>
        {summary.week.map((entry, index) => {
          const isToday = index === summary.week.length - 1
          return (
            <View
              key={entry.day}
              accessibilityLabel={`${weekday(entry.day, "long")}: ${entry.xp} XP`}
              style={styles.day}
            >
              <View style={styles.dayBarArea}>
                <View
                  style={[
                    styles.dayBar,
                    {
                      height: `${Math.max(6, (entry.xp / ceiling) * 100)}%`,
                      backgroundColor:
                        entry.xp >= summary.goal ? colors.brand : entry.xp ? brandAlpha(0.35) : colors.muted,
                    },
                    isToday && styles.dayBarToday,
                  ]}
                />
              </View>
              <Text style={[styles.dayLabel, isToday && styles.dayLabelToday]}>{weekday(entry.day, "narrow")}</Text>
            </View>
          )
        })}
      </View>

      {resume ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Continue ${resume.unitTitle}. ${resume.detail}`}
          onPress={() => onContinue(resume.projectId, resume.unitId)}
          style={({ pressed }) => [styles.resume, pressed && styles.pressed]}
        >
          <View style={styles.resumeText}>
            <Text numberOfLines={1} style={styles.eyebrow}>
              Continue {resume.projectTitle}
            </Text>
            <Text numberOfLines={1} style={styles.resumeTitle}>
              {resume.unitTitle}
            </Text>
            <Text numberOfLines={1} style={styles.small}>
              {resume.detail}
            </Text>
            <SegmentedBar
              style={styles.resumeBar}
              segments={pathSegments(sectionStates(resume.sectionIds, resume.sectionIndex, resume.taughtSectionIds))}
            />
          </View>
          <View style={styles.arrow}>
            <Text style={styles.arrowText}>›</Text>
          </View>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenLibrary}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        >
          <Text style={styles.primaryText}>Pick a module to learn</Text>
        </Pressable>
      )}

      <Text style={[styles.muted, styles.footer]}>
        {offline
          ? "Offline. Showing what was saved on this phone."
          : summary.dueConcepts
            ? `${summary.dueConcepts} concept${summary.dueConcepts === 1 ? " is" : "s are"} due for review. Swipe up to review.`
            : hasCards
              ? "Swipe up for questions on what you've studied."
              : "Questions appear here once you start learning a unit."}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, justifyContent: "center", paddingHorizontal: 24, maxWidth: 680, width: "100%", alignSelf: "center" },
  muted: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
  small: { color: colors.mutedForeground, fontSize: 12, lineHeight: 18 },
  streak: { color: colors.foreground, fontSize: 40, fontWeight: "600", letterSpacing: -1.5, lineHeight: 46, marginTop: 4 },
  goal: { marginTop: 28, gap: 8 },
  goalHeader: { flexDirection: "row", justifyContent: "space-between" },
  goalLabel: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  track: { backgroundColor: colors.muted, borderRadius: 999, height: 8, overflow: "hidden" },
  trackFill: { backgroundColor: colors.brand, borderRadius: 999, height: "100%" },
  week: { flexDirection: "row", gap: 8, height: 96, marginTop: 28 },
  day: { alignItems: "center", flex: 1, gap: 6 },
  dayBarArea: { flex: 1, justifyContent: "flex-end", width: "100%", alignItems: "center" },
  dayBar: { borderRadius: 6, maxWidth: 30, width: "100%" },
  dayBarToday: { borderColor: brandAlpha(0.5), borderWidth: 2 },
  dayLabel: { color: colors.faint, fontSize: 11 },
  dayLabelToday: { color: colors.foreground, fontWeight: "600" },
  resume: {
    alignItems: "center",
    backgroundColor: colors.brandTint,
    borderColor: colors.brandBorder,
    borderRadius: radius.xl,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    marginTop: 28,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  resumeText: { flex: 1, gap: 2 },
  eyebrow: { color: colors.brand, fontSize: 12, fontWeight: "600" },
  resumeTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  resumeBar: { marginTop: 10 },
  arrow: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: 999,
    height: TOUCH_TARGET,
    justifyContent: "center",
    width: TOUCH_TARGET,
  },
  arrowText: { color: colors.brandForeground, fontSize: 24, lineHeight: 26 },
  primary: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    marginTop: 28,
    minHeight: 48,
  },
  primaryText: { color: colors.brandForeground, fontSize: 15, fontWeight: "600" },
  pressed: { opacity: 0.75 },
  footer: { marginTop: 16 },
})
