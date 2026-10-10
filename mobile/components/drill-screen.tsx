/**
 * A practice drill on the phone, matching the desktop drill: ten questions
 * from the module (or one unit), missed and weak material first, asked one at
 * a time with the answer key revealed after each. A wrong answer offers
 * Relearn, which reopens the unit's Teach session on that concept. The drill
 * ends with the session summary.
 *
 * Answers are queued on the device before they are sent (the feed's queue),
 * so a drill can be finished offline from a saved deck and synced later.
 */

import { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import type { MobileDrillQuestion } from "../../lib/learning/mobile-contracts"
import { relearnMessage } from "../../lib/teach"
import { removePendingEvent, enqueueEvent } from "../lib/storage"
import { submitAnswer } from "../lib/api"
import type { MobileAnswer, MobileAnswerFeedback } from "../lib/contracts"
import { fetchDrill } from "../lib/learning-api"
import { loadCached, saveCached } from "../lib/offline-cache"
import { brandAlpha, colors, radius, TOUCH_TARGET } from "../lib/theme"
import { questionResult } from "./learning-card"
import { Text } from "./native-text"
import { SegmentedBar } from "./progress-path"
import { QuestionView } from "./question-view"
import { SessionSummary } from "./session-summary"

/** Props for a drill. */
export type DrillScreenProps = {
  readonly serverUrl: string
  readonly projectId: string
  /** Limits the drill to one unit. */
  readonly unitId?: string
  readonly onBack: () => void
  /** Opens a unit's Teach session with a Relearn request. */
  readonly onRelearn: (unitId: string, ask: string) => void
}

/** Converts the question view's answer to the shared answer route's value. */
function answerValue(type: MobileDrillQuestion["card"]["type"], answer: string[]): MobileAnswer {
  if (type === "single-choice") return answer[0] ?? ""
  if (type === "true-false") return answer[0] === "true"
  return answer
}

/** Renders a drill from first question to summary. */
export function DrillScreen({ serverUrl, projectId, unitId, onBack, onRelearn }: DrillScreenProps) {
  const insets = useSafeAreaInsets()
  const [questions, setQuestions] = useState<MobileDrillQuestion[]>()
  const [error, setError] = useState("")
  const [offline, setOffline] = useState(false)
  const [index, setIndex] = useState(0)
  const [feedback, setFeedback] = useState<Record<string, MobileAnswerFeedback>>({})
  const [sending, setSending] = useState(false)
  const [finished, setFinished] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [startedAt, setStartedAt] = useState(() => Date.now())
  const cacheName = `drill:${projectId}:${unitId ?? "all"}`

  // Loads the deck once per drill so answering does not reshuffle it.
  useEffect(() => {
    let cancelled = false
    setQuestions(undefined)
    setError("")
    void (async () => {
      try {
        const deck = await fetchDrill(serverUrl, projectId, unitId)
        if (cancelled) return
        setQuestions(deck.questions)
        setOffline(false)
        await saveCached(serverUrl, cacheName, deck.questions)
      } catch (caught) {
        const cached = await loadCached<MobileDrillQuestion[]>(serverUrl, cacheName)
        if (cancelled) return
        if (cached?.value.length) {
          setQuestions(cached.value)
          setOffline(true)
        } else setError(caught instanceof Error ? caught.message : "The drill could not be loaded.")
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverUrl, projectId, unitId, cacheName, attempt])

  const current = questions?.[index]
  const currentFeedback = current ? feedback[current.card.id] : undefined
  const scored = currentFeedback?.status === "correct" || currentFeedback?.status === "incorrect"
  const segments = useMemo(
    () =>
      (questions ?? []).map((question, position) => {
        // Correct answers fill in brand, misses fill faintly, skipped questions stay grey.
        const result = feedback[question.card.id]
        return {
          key: question.card.id,
          fill: result || position < index ? 1 : position === index ? 0.5 : 0,
          color: !result
            ? position < index
              ? colors.border
              : colors.brand
            : result.status === "incorrect"
              ? brandAlpha(0.3)
              : colors.brand,
        }
      }),
    [questions, feedback, index]
  )

  /** Queues the answer, sends it, and shows the server's verdict (or a pending note). */
  async function answer(value: string[]) {
    if (!current || sending || currentFeedback) return
    setSending(true)
    const event = await enqueueEvent(
      projectId,
      current.card.id,
      "answer",
      answerValue(current.card.type, value),
      serverUrl
    )
    try {
      const result = await submitAnswer(serverUrl, event)
      await removePendingEvent(event.eventId, serverUrl)
      setFeedback((all) => ({ ...all, [current.card.id]: result }))
    } catch {
      // Kept in the queue; the feed delivers it when the server is back.
      setFeedback((all) => ({ ...all, [current.card.id]: { status: "pending" } }))
      setOffline(true)
    } finally {
      setSending(false)
    }
  }

  /** Moves to the next question, or to the summary after the last. */
  function next() {
    if (!questions) return
    if (index + 1 < questions.length) setIndex(index + 1)
    else setFinished(true)
  }

  /** Starts a fresh drill with a new deck. */
  function again() {
    setFeedback({})
    setIndex(0)
    setFinished(false)
    setStartedAt(Date.now())
    setAttempt((count) => count + 1)
  }

  const missed = (questions ?? []).filter((question) => feedback[question.card.id]?.status === "incorrect")

  return (
    <View style={[styles.root, { paddingTop: 8 + insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close drill" onPress={onBack} style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>
        <SegmentedBar segments={segments} style={styles.bar} />
        <Text style={styles.count}>{questions?.length ? `${Math.min(index + 1, questions.length)}/${questions.length}` : ""}</Text>
      </View>
      {offline ? <Text style={styles.offline}>Offline · answers are saved and sync later.</Text> : null}

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 40 + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
      >
        {!questions ? (
          error ? (
            <View style={styles.centered}>
              <Text style={styles.body}>{error}</Text>
              <SecondaryButton label="Try again" onPress={() => setAttempt((count) => count + 1)} />
            </View>
          ) : (
            <ActivityIndicator color={colors.brand} style={styles.loading} />
          )
        ) : !questions.length ? (
          <View style={styles.centered}>
            <Text style={styles.body}>No questions yet. Learn a unit first, and questions are written for it.</Text>
            <SecondaryButton label="Back" onPress={onBack} />
          </View>
        ) : finished ? (
          <SessionSummary
            serverUrl={serverUrl}
            projectId={projectId}
            {...(unitId ? { unitId } : {})}
            since={startedAt}
            eyebrow="Drill complete"
            actions={
              <>
                <PrimaryButton label="Drill again" onPress={again} />
                <SecondaryButton label="Back to the module" onPress={onBack} />
              </>
            }
          >
            {missed.length ? (
              <View style={styles.missed}>
                <Text style={styles.label}>Missed</Text>
                {missed.map((question) => (
                  <View key={question.card.id} style={styles.missedRow}>
                    <Text numberOfLines={2} style={styles.missedText}>
                      {question.card.title}
                    </Text>
                    <SecondaryButton
                      label="Relearn"
                      onPress={() =>
                        onRelearn(question.unitId, relearnMessage(question.card.title, question.card.question))
                      }
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </SessionSummary>
        ) : current ? (
          <View style={styles.question}>
            <Text style={styles.eyebrow}>
              {current.card.title}
              {current.lastOutcome === "incorrect" ? " · missed last time" : ""}
            </Text>
            <QuestionView
              key={current.card.id}
              shape={{
                type: current.card.type,
                question: current.card.question,
                options: current.card.options ?? [],
                ...(current.card.prompts ? { prompts: current.card.prompts } : {}),
              }}
              result={questionResult(currentFeedback)}
              pendingLabel={currentFeedback?.status === "pending" ? "Answer saved · waiting for sync" : undefined}
              disabled={sending}
              onSubmit={(value) => void answer(value)}
            />
            {currentFeedback?.status === "invalid" ? (
              <Text style={styles.error}>This answer could not be scored. Skip to the next question.</Text>
            ) : null}
            <View style={styles.actions}>
              {currentFeedback ? (
                <PrimaryButton label={index + 1 < questions.length ? "Next question" : "See summary"} onPress={next} />
              ) : (
                <Pressable accessibilityRole="button" onPress={next} style={styles.skip}>
                  <Text style={styles.skipText}>Skip</Text>
                </Pressable>
              )}
              {scored && currentFeedback?.status === "incorrect" ? (
                <SecondaryButton
                  label="Relearn"
                  onPress={() => onRelearn(current.unitId, relearnMessage(current.card.title, current.card.question))}
                />
              ) : null}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}

/** The main action. */
function PrimaryButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  )
}

/** A secondary action. */
function SecondaryButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12 },
  close: { alignItems: "center", height: TOUCH_TARGET, justifyContent: "center", width: TOUCH_TARGET },
  closeText: { color: colors.text, fontSize: 18 },
  bar: { flex: 1 },
  count: { color: colors.mutedForeground, fontSize: 12, minWidth: 34, textAlign: "right" },
  offline: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 20, paddingTop: 6 },
  content: { padding: 20, gap: 16, maxWidth: 680, width: "100%", alignSelf: "center" },
  loading: { marginTop: 80 },
  centered: { alignItems: "center", gap: 14, marginTop: 60 },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 22, textAlign: "center" },
  question: { gap: 14 },
  eyebrow: { color: colors.brand, fontSize: 13, fontWeight: "600" },
  error: { color: "#ff9a89", fontSize: 13 },
  actions: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 6 },
  skip: { justifyContent: "center", minHeight: TOUCH_TARGET, paddingHorizontal: 12 },
  skipText: { color: colors.mutedForeground, fontSize: 14 },
  primary: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 22,
  },
  primaryText: { color: colors.brandForeground, fontSize: 15, fontWeight: "600" },
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
  pressed: { opacity: 0.72 },
  label: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  missed: { gap: 8 },
  missedRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  missedText: { color: colors.text, flex: 1, fontSize: 14 },
})
