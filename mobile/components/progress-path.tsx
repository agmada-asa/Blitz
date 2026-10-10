/**
 * Native versions of the web app's progress visuals
 * (`components/progress/progress-path.tsx`): a segmented bar with one segment
 * per section, unit, or concept, and the round path marker for one step.
 * Both are decorative; screens state the same progress in text.
 */

import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native"

import { colors } from "../lib/theme"
import { Text } from "./native-text"

/** Where one step of a path stands. */
export type PathState = "done" | "current" | "ahead"

/** One bar segment: how full it is (0 to 1) and an optional colour. */
export type BarSegment = { key: string; fill: number; color?: string }

/**
 * Converts path states to segments: done is full, current half, ahead empty,
 * matching the Teach header.
 */
export function pathSegments(steps: Array<{ key: string; state: PathState }>): BarSegment[] {
  return steps.map(({ key, state }) => ({
    key,
    fill: state === "done" ? 1 : state === "current" ? 0.5 : 0,
  }))
}

/**
 * Returns the state of each section of a Teach outline, with the current
 * section taking precedence over "taught", as on desktop.
 */
export function sectionStates(
  sectionIds: readonly string[],
  sectionIndex: number,
  taughtSectionIds: readonly string[],
  completed = false
): Array<{ key: string; state: PathState }> {
  const taught = new Set(taughtSectionIds)
  return sectionIds.map((id, index) => ({
    key: id,
    state: completed
      ? "done"
      : index === sectionIndex
        ? "current"
        : taught.has(id)
          ? "done"
          : "ahead",
  }))
}

/** Draws a row of equal segments, each filled to its own amount. */
export function SegmentedBar({
  segments,
  thin = false,
  style,
}: {
  readonly segments: BarSegment[]
  readonly thin?: boolean
  readonly style?: StyleProp<ViewStyle>
}) {
  if (!segments.length) return null
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.bar, segments.length > 24 && styles.barDense, style]}
    >
      {segments.map((segment) => (
        <View key={segment.key} style={[styles.segment, thin && styles.segmentThin]}>
          <View
            style={[
              styles.fill,
              {
                width: `${Math.round(Math.min(1, Math.max(0, segment.fill)) * 100)}%`,
                backgroundColor: segment.color ?? colors.brand,
              },
            ]}
          />
        </View>
      ))}
    </View>
  )
}

/** The round marker for one path step: a tick when done, a ringed number when current. */
export function PathMarker({ state, number }: { readonly state: PathState; readonly number: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.marker,
        state === "done" && styles.markerDone,
        state === "current" && styles.markerCurrent,
      ]}
    >
      <Text
        style={[
          styles.markerText,
          state === "done" && styles.markerTextDone,
          state === "current" && styles.markerTextCurrent,
        ]}
      >
        {state === "done" ? "✓" : String(number)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", gap: 4, width: "100%" },
  barDense: { gap: 1 },
  segment: {
    backgroundColor: colors.muted,
    borderRadius: 999,
    flex: 1,
    height: 6,
    overflow: "hidden",
  },
  segmentThin: { height: 4 },
  fill: { borderRadius: 999, height: "100%" },
  marker: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  markerDone: { backgroundColor: colors.brand, borderColor: colors.brand },
  markerCurrent: {
    borderColor: colors.brand,
    borderWidth: 2,
    shadowColor: colors.brand,
  },
  markerText: { color: colors.mutedForeground, fontSize: 13, fontWeight: "600" },
  markerTextDone: { color: colors.brandForeground },
  markerTextCurrent: { color: colors.brand },
})
