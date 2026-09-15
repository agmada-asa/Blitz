/** Renders the native written-answer activity with persisted drafts and references. */

import { useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  fetchWritingActivity,
  saveWritingAnswer,
  startWritingActivity,
  type MobileWritingActivity,
} from "../lib/writing"

/** Props required for one project-scoped native written activity. */
export type WrittenActivityProps = {
  readonly serverUrl: string
  readonly projectId: string
  readonly topicId?: string
  readonly onClose: () => void
}

/** Loads, resumes, and renders a persisted five-prompt written activity. */
export function WrittenActivity({
  serverUrl,
  projectId,
  topicId,
  onClose,
}: WrittenActivityProps) {
  const insets = useSafeAreaInsets()
  const [activity, setActivity] = useState<MobileWritingActivity | null>()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<"draft" | "compare" | "start">()
  const [error, setError] = useState("")
  const [draftSaved, setDraftSaved] = useState(false)
  const positionedActivityId = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    setActivity(undefined)
    setError("")
    void fetchWritingActivity(serverUrl, projectId, topicId)
      .then(async (loaded) => {
        if (!active) return
        if (loaded) {
          setActivity(loaded)
          return
        }
        setPending("start")
        const started = await startWritingActivity(
          serverUrl,
          projectId,
          topicId
        )
        if (active) setActivity(started)
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Written activity could not start"
          )
      })
      .finally(() => {
        if (active) setPending(undefined)
      })
    return () => {
      active = false
    }
  }, [projectId, serverUrl, topicId])

  useEffect(() => {
    if (!activity || positionedActivityId.current === activity._id) return
    positionedActivityId.current = activity._id
    const unfinishedIndex = activity.items.findIndex((entry) => !entry.revealed)
    setCurrentIndex(
      unfinishedIndex < 0
        ? Math.max(0, activity.items.length - 1)
        : unfinishedIndex
    )
  }, [activity])

  const item = activity?.items[currentIndex]
  const answer = item ? (drafts[item.itemId] ?? item.answer ?? "") : ""

  /** Saves a draft or compares the current answer against the source reference. */
  async function submit(reveal: boolean): Promise<void> {
    if (!activity || !item || !answer.trim() || pending) return
    setPending(reveal ? "compare" : "draft")
    setError("")
    try {
      const updated = await saveWritingAnswer(serverUrl, {
        projectId,
        activityId: activity._id,
        itemId: item.itemId,
        answer,
        reveal,
      })
      setActivity(updated)
      setDraftSaved(!reveal)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The answer could not be saved"
      )
    } finally {
      setPending(undefined)
    }
  }

  /** Starts the next persisted activity after all prompts have been compared. */
  async function startNewActivity(): Promise<void> {
    if (pending || activity?.status !== "completed") return
    setPending("start")
    setError("")
    try {
      const started = await startWritingActivity(serverUrl, projectId, topicId)
      if (!started) {
        setError("No explanation prompts are ready for a new activity.")
        return
      }
      setDrafts({})
      setCurrentIndex(0)
      setDraftSaved(false)
      setActivity(started)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Written activity could not start"
      )
    } finally {
      setPending(undefined)
    }
  }

  /** Moves to another prompt without changing persisted answer state. */
  function moveTo(index: number): void {
    if (!activity || index < 0 || index >= activity.items.length || pending)
      return
    setCurrentIndex(index)
    setError("")
    setDraftSaved(false)
  }

  if (activity === undefined)
    return (
      <View
        style={[
          styles.root,
          styles.centered,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        {pending ? <ActivityIndicator color="#ff8065" /> : null}
        <Text style={styles.status}>
          {error || "Loading written activity…"}
        </Text>
        {error ? <Action label="Back to project" onPress={onClose} /> : null}
      </View>
    )
  if (!activity || !item)
    return (
      <View
        style={[
          styles.root,
          styles.centered,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <Text style={styles.title}>Written answers</Text>
        <Text style={styles.status}>
          {error || "No explanation prompts are ready for this activity."}
        </Text>
        <Action label="Back to project" onPress={onClose} />
      </View>
    )

  const revealed = item.revealed
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.root}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={styles.back}
          >
            <Text style={styles.backText}>Back to project</Text>
          </Pressable>
          <Text style={styles.headerMeta}>
            {activity.status === "completed"
              ? "Activity complete"
              : `${currentIndex + 1} of ${activity.items.length}`}
          </Text>
        </View>
        <Text style={styles.title}>{item.prompt}</Text>
        {revealed ? (
          <>
            <Text style={styles.sectionLabel}>Your saved answer</Text>
            <Text style={styles.body}>{item.answer}</Text>
            <View style={styles.divider} />
            <Text style={styles.sectionLabel}>Reference</Text>
            <Text style={styles.body}>{item.reference}</Text>
            <Text style={styles.source}>
              Source: {item.sourceLabels.join(", ")}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Your answer</Text>
            <TextInput
              accessibilityLabel="Your answer"
              multiline
              maxLength={10_000}
              editable={!pending}
              onChangeText={(value) => {
                setDrafts((current) => ({ ...current, [item.itemId]: value }))
                setDraftSaved(false)
                setError("")
              }}
              placeholder="Write your answer…"
              placeholderTextColor="#717171"
              style={styles.textInput}
              textAlignVertical="top"
              value={answer}
            />
            <View style={styles.actionRow}>
              <Action
                label={pending === "draft" ? "Saving…" : "Save draft"}
                onPress={() => void submit(false)}
                disabled={!answer.trim() || Boolean(pending)}
              />
              <Action
                label={pending === "compare" ? "Comparing…" : "Compare answer"}
                onPress={() => void submit(true)}
                disabled={!answer.trim() || Boolean(pending)}
                accent
              />
            </View>
            {draftSaved ? (
              <Text style={styles.status}>Draft saved.</Text>
            ) : null}
          </>
        )}
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <Action
            label="Previous"
            onPress={() => moveTo(currentIndex - 1)}
            disabled={currentIndex === 0 || Boolean(pending)}
          />
          {currentIndex < activity.items.length - 1 ? (
            <Action
              label="Next"
              onPress={() => moveTo(currentIndex + 1)}
              disabled={!revealed || Boolean(pending)}
              accent
            />
          ) : activity.status === "completed" ? (
            <Action
              label={pending === "start" ? "Starting…" : "New activity"}
              onPress={() => void startNewActivity()}
              disabled={Boolean(pending)}
              accent
            />
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** Renders a compact native action with disabled and accent variants. */
function Action({
  label,
  onPress,
  disabled,
  accent,
}: {
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly accent?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        accent && styles.accent,
        (disabled || pressed) && styles.pressed,
      ]}
    >
      <Text style={[styles.actionText, accent && styles.accentText]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { backgroundColor: "#101010", flex: 1 },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  content: { paddingHorizontal: 20 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 48,
  },
  back: { minHeight: 42, justifyContent: "center", paddingHorizontal: 6 },
  backText: { color: "#b4b4b4", fontSize: 14 },
  headerMeta: { color: "#909090", fontSize: 13 },
  title: { color: "#f7f7f7", fontSize: 31, fontWeight: "500", lineHeight: 35 },
  sectionLabel: {
    color: "#d8d8d8",
    fontSize: 14,
    fontWeight: "500",
    marginTop: 28,
  },
  body: { color: "#aaaaaa", fontSize: 15, lineHeight: 24, marginTop: 9 },
  textInput: {
    backgroundColor: "#191919",
    borderColor: "#383838",
    borderRadius: 14,
    borderWidth: 1,
    color: "#f7f7f7",
    fontSize: 16,
    lineHeight: 24,
    marginTop: 10,
    minHeight: 190,
    padding: 14,
  },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 14 },
  action: {
    alignItems: "center",
    borderColor: "#3a3a3a",
    borderRadius: 22,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 16,
  },
  actionText: { color: "#d0d0d0", fontSize: 14 },
  accent: { backgroundColor: "#ff8065", borderColor: "#ff8065" },
  accentText: { color: "#1b0d0a", fontWeight: "600" },
  pressed: { opacity: 0.52 },
  status: {
    color: "#929292",
    fontSize: 14,
    lineHeight: 22,
    marginTop: 16,
    textAlign: "center",
  },
  error: { color: "#ff9a89", fontSize: 14, lineHeight: 22, marginTop: 16 },
  divider: {
    borderTopColor: "#303030",
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 28,
  },
  source: { color: "#666666", fontSize: 12, marginTop: 14 },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 52,
  },
})
