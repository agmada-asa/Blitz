/**
 * A module on the phone, matching the desktop module and Practice pages: the
 * unit to continue, the learning path of units with their Teach progress, a
 * drill with the module's concept mastery, concepts that are not sticking
 * with a way back into Teach, and the exam papers.
 *
 * Opening a unit starts its Teach session; Start drill opens a drill. The
 * last copy is kept on the device so the path can be read offline.
 */

import { useCallback, useEffect, useState } from "react"
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import type { MobileConceptStrength, MobileModuleResponse, MobileUnit } from "../../lib/learning/mobile-contracts"
import { relearnMessage } from "../../lib/teach"
import { fetchModule } from "../lib/learning-api"
import { loadCached, saveCached } from "../lib/offline-cache"
import { brandAlpha, colors, radius, TOUCH_TARGET } from "../lib/theme"
import { Text } from "./native-text"
import { PathMarker, SegmentedBar, pathSegments, sectionStates, type BarSegment, type PathState } from "./progress-path"

/** Props for the module screen. */
export type ModuleScreenProps = {
  readonly serverUrl: string
  readonly projectId: string
  readonly onBack: () => void
  readonly onOpenUnit: (unitId: string, ask?: string) => void
  readonly onStartDrill: (unitId?: string) => void
  /** Opens the module's sources, files, and research. */
  readonly onOpenSources: () => void
  readonly onOpenChat: (project: { id: string; title: string }) => void
}

/** Words and colours for each concept strength, as on the desktop Practice page. */
export const STRENGTH_STYLE: Record<MobileConceptStrength, { label: string; color: string; fill: number }> = {
  strong: { label: "strong", color: colors.brand, fill: 1 },
  learning: { label: "learning", color: brandAlpha(0.6), fill: 0.6 },
  weak: { label: "need work", color: brandAlpha(0.3), fill: 0.25 },
  new: { label: "not practised", color: colors.faint, fill: 0 },
}

/** Strengths from strongest to newest, the order concept bars are drawn in. */
const STRENGTH_ORDER: MobileConceptStrength[] = ["strong", "learning", "weak", "new"]

/** Draws concepts as segments grouped by strength and filled by mastery. */
export function conceptSegments(concepts: ReadonlyArray<{ id: string; strength: MobileConceptStrength }>): BarSegment[] {
  return [...concepts]
    .sort((a, b) => STRENGTH_ORDER.indexOf(a.strength) - STRENGTH_ORDER.indexOf(b.strength))
    .map((concept) => ({
      key: concept.id,
      fill: STRENGTH_STYLE[concept.strength].fill,
      color: STRENGTH_STYLE[concept.strength].color,
    }))
}

/** Counts concepts per strength, for example "3 strong · 2 learning". */
export function strengthCounts(concepts: ReadonlyArray<{ strength: MobileConceptStrength }>): string {
  return STRENGTH_ORDER.map((strength) => {
    const count = concepts.filter((concept) => concept.strength === strength).length
    return count ? `${count} ${STRENGTH_STYLE[strength].label}` : ""
  })
    .filter(Boolean)
    .join(" · ")
}

/** Picks the unit to continue: the furthest unfinished one with progress, else the first not started. */
function nextUnit(units: readonly MobileUnit[]): MobileUnit | undefined {
  return (
    units.find((unit) => unit.teach && unit.teach.sectionCount > 0 && !unit.teach.completed) ??
    units.find((unit) => !unit.teach?.completed && unit.hasText)
  )
}

/** Describes a unit's Teach progress in words. */
function unitStatus(unit: MobileUnit): string {
  const sources = `${unit.sourceCount} source${unit.sourceCount === 1 ? "" : "s"}`
  const teach = unit.teach
  if (!unit.hasText) return `${sources} · Preparing`
  if (!teach || teach.sectionCount === 0) return `${sources} · Not started`
  if (teach.completed) return `${sources} · Done`
  return `${sources} · Section ${teach.sectionIndex + 1} of ${teach.sectionCount}`
}

/** Renders a module's learning path and practice. */
export function ModuleScreen({
  serverUrl,
  projectId,
  onBack,
  onOpenUnit,
  onStartDrill,
  onOpenSources,
  onOpenChat,
}: ModuleScreenProps) {
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<MobileModuleResponse>()
  const [error, setError] = useState("")
  const [offline, setOffline] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  /** Loads the module, showing the saved copy first and when offline. */
  const load = useCallback(async () => {
    const cached = await loadCached<MobileModuleResponse>(serverUrl, `module:${projectId}`)
    if (cached) setData((current) => current ?? cached.value)
    try {
      const fresh = await fetchModule(serverUrl, projectId)
      setData(fresh)
      setOffline(false)
      setError("")
      await saveCached(serverUrl, `module:${projectId}`, fresh)
    } catch (caught) {
      setOffline(Boolean(cached))
      if (!cached) setError(caught instanceof Error ? caught.message : "This module could not be loaded.")
    }
  }, [serverUrl, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const units = data?.units ?? []
  const next = nextUnit(units)
  const concepts = units.flatMap((unit) => unit.concepts)
  const practice = data?.practice
  const drillSummary = practice
    ? [
        practice.missedCount ? `${practice.missedCount} to retry` : "",
        practice.weakConcepts.length
          ? `${practice.weakConcepts.length} weak concept${practice.weakConcepts.length === 1 ? "" : "s"}`
          : "",
        practice.unansweredCount ? `${practice.unansweredCount} new` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : ""

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: 16 + insets.top, paddingBottom: 110 + insets.bottom }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.brand}
            onRefresh={() => {
              setRefreshing(true)
              void load().finally(() => setRefreshing(false))
            }}
          />
        }
      >
        <View style={styles.topBar}>
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
            <Text style={styles.backText}>‹ Library</Text>
          </Pressable>
          {data ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpenChat({ id: data.id, title: data.title })}
              style={styles.back}
            >
              <Text style={styles.backText}>Ask Blitz</Text>
            </Pressable>
          ) : null}
        </View>

        {!data ? (
          error ? (
            <View style={styles.centered}>
              <Text style={styles.body}>{error}</Text>
              <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.secondary}>
                <Text style={styles.secondaryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <ActivityIndicator color={colors.brand} style={styles.loading} />
          )
        ) : (
          <>
            <Text accessibilityRole="header" style={styles.title}>
              {data.title}
            </Text>
            {offline ? <Text style={styles.notice}>Offline. Showing what was saved on this phone.</Text> : null}

            {next ? (
              <View style={styles.hero}>
                <Text style={styles.eyebrow}>
                  {next.teach?.sectionCount ? "Continue where you left off" : "Up next"}
                </Text>
                <Text style={styles.heroTitle}>{next.title}</Text>
                <Text style={styles.small}>
                  {next.teach?.currentSectionTitle
                    ? `Section ${next.teach.sectionIndex + 1} of ${next.teach.sectionCount} · ${next.teach.currentSectionTitle}`
                    : unitStatus(next)}
                </Text>
                {next.teach ? (
                  <SegmentedBar
                    style={styles.heroBar}
                    segments={pathSegments(
                      sectionStates(next.teach.sectionIds, next.teach.sectionIndex, next.teach.taughtSectionIds)
                    )}
                  />
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={() => onOpenUnit(next.id)}
                  style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryText}>
                    {next.teach?.sectionCount ? "Continue learning" : "Start learning"}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Learning path
            </Text>
            {units.length ? (
              <View>
                {units.map((unit, index) => {
                  const state: PathState = unit.teach?.completed
                    ? "done"
                    : unit.id === next?.id
                      ? "current"
                      : "ahead"
                  return (
                    <Pressable
                      key={unit.id}
                      accessibilityRole="button"
                      accessibilityLabel={`${unit.title}. ${unitStatus(unit)}`}
                      disabled={!unit.hasText}
                      onPress={() => onOpenUnit(unit.id)}
                      style={({ pressed }) => [
                        styles.unit,
                        state === "current" && styles.unitCurrent,
                        pressed && styles.pressed,
                      ]}
                    >
                      {index < units.length - 1 ? (
                        <View style={[styles.connector, state === "done" && styles.connectorDone]} />
                      ) : null}
                      <PathMarker state={state} number={index + 1} />
                      <View style={styles.unitText}>
                        <Text style={styles.unitTitle}>{unit.title}</Text>
                        <Text style={styles.small}>{unitStatus(unit)}</Text>
                        {unit.teach ? (
                          <SegmentedBar
                            thin
                            style={styles.unitBar}
                            segments={pathSegments(
                              sectionStates(
                                unit.teach.sectionIds,
                                unit.teach.sectionIndex,
                                unit.teach.taughtSectionIds,
                                unit.teach.completed
                              )
                            )}
                          />
                        ) : null}
                      </View>
                    </Pressable>
                  )
                })}
              </View>
            ) : (
              <Text style={styles.body}>
                {data.unsortedSourceCount
                  ? "This module's sources aren't in units yet. Group them on your computer to start learning."
                  : "Add this week's material on your computer, then learn it here."}
              </Text>
            )}

            <Text accessibilityRole="header" style={styles.sectionTitle}>
              Practice
            </Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Drill</Text>
              <Text style={styles.small}>
                {practice?.questionCount
                  ? drillSummary || "Every question answered correctly. Drill to keep it fresh."
                  : "Questions are written once you start learning a unit."}
              </Text>
              {concepts.length ? (
                <>
                  <SegmentedBar style={styles.heroBar} segments={conceptSegments(concepts)} />
                  <Text style={styles.small}>
                    {concepts.length} concept{concepts.length === 1 ? "" : "s"}: {strengthCounts(concepts)}
                  </Text>
                </>
              ) : null}
              <Pressable
                accessibilityRole="button"
                disabled={!practice?.questionCount}
                onPress={() => onStartDrill()}
                style={({ pressed }) => [
                  styles.primary,
                  !practice?.questionCount && styles.disabled,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryText}>Start drill</Text>
              </Pressable>
            </View>

            {practice?.weakConcepts.length ? (
              <>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  Not sticking yet
                </Text>
                <View style={styles.list}>
                  {practice.weakConcepts.slice(0, 8).map((concept) => (
                    <View key={concept.id} style={styles.weak}>
                      <View style={styles.unitText}>
                        <Text style={styles.unitTitle}>{concept.title}</Text>
                        <Text numberOfLines={1} style={styles.small}>
                          {concept.unitTitle}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Relearn ${concept.title}`}
                        onPress={() => onOpenUnit(concept.unitId, relearnMessage(concept.title))}
                        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
                      >
                        <Text style={styles.secondaryText}>Relearn</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </>
            ) : null}

            {data.papers.length ? (
              <>
                <Text accessibilityRole="header" style={styles.sectionTitle}>
                  Exam papers
                </Text>
                <View style={styles.list}>
                  {data.papers.map((paper) => (
                    <View key={paper.id} style={styles.paper}>
                      <Text style={styles.unitTitle}>{paper.title}</Text>
                      <Text style={styles.small}>
                        {[
                          paper.kind === "mock" ? "Mock exam" : "Past paper",
                          `${paper.questionCount} questions`,
                          paper.totalMarks ? `${paper.totalMarks} marks` : "",
                          paper.durationMinutes ? `${paper.durationMinutes} min` : "",
                          paper.bestPercentage !== null ? `Best ${paper.bestPercentage}%` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </View>
                  ))}
                  <Text style={styles.small}>Sit exams on your computer, where written answers are easier.</Text>
                </View>
              </>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={onOpenSources}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Text style={styles.unitTitle}>Sources and files</Text>
              <Text style={styles.small}>›</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20, gap: 12, maxWidth: 720, width: "100%", alignSelf: "center" },
  topBar: { flexDirection: "row", justifyContent: "space-between" },
  back: { minHeight: TOUCH_TARGET, justifyContent: "center", paddingRight: 8 },
  backText: { color: colors.text, fontSize: 15 },
  loading: { marginTop: 80 },
  centered: { alignItems: "center", gap: 14, marginTop: 80 },
  title: { color: colors.foreground, fontSize: 32, fontWeight: "600", letterSpacing: -1, lineHeight: 38 },
  notice: { color: colors.mutedForeground, fontSize: 13 },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 22 },
  small: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  eyebrow: { color: colors.brand, fontSize: 12, fontWeight: "600" },
  hero: {
    backgroundColor: colors.brandTint,
    borderColor: colors.brandBorder,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: 4,
    marginTop: 8,
    padding: 18,
  },
  heroTitle: { color: colors.foreground, fontSize: 19, fontWeight: "600", lineHeight: 25 },
  heroBar: { marginVertical: 8 },
  primary: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    marginTop: 8,
    minHeight: 48,
  },
  primaryText: { color: colors.brandForeground, fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.75 },
  sectionTitle: { color: colors.foreground, fontSize: 18, fontWeight: "600", marginTop: 16 },
  unit: {
    alignItems: "flex-start",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  unitCurrent: { backgroundColor: brandAlpha(0.07) },
  connector: { backgroundColor: colors.border, bottom: -14, left: 25.5, position: "absolute", top: 46, width: 1 },
  connectorDone: { backgroundColor: colors.brand },
  unitText: { flex: 1, gap: 2 },
  unitTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  unitBar: { marginTop: 8, maxWidth: 260 },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: 4,
    padding: 18,
  },
  cardTitle: { color: colors.foreground, fontSize: 18, fontWeight: "600" },
  list: { gap: 8 },
  weak: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingLeft: 14,
    paddingRight: 8,
    paddingVertical: 8,
  },
  secondary: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 16,
  },
  secondaryText: { color: colors.text, fontSize: 14 },
  paper: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 2,
    padding: 14,
  },
  row: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 16,
    minHeight: 54,
    paddingHorizontal: 16,
  },
})
