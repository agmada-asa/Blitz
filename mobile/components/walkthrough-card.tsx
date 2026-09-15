/** Renders one project learning-path item with native answer and deep-dive controls. */

import { useEffect, useState, type ReactNode } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

import { Markdown } from "./markdown"
import type { AnswerResponse } from "../../lib/learning/client-contracts"
import type { MobileAnswer, MobileAnswerFeedback } from "../lib/contracts"
import type { MobileWorkspaceItem } from "../lib/project-workspace-api"

/** Props connecting one walkthrough card to project-level navigation and scoring. */
export type WalkthroughCardProps = {
  readonly item: MobileWorkspaceItem
  readonly conceptTitle: string
  readonly position: number
  readonly total: number
  readonly onAnswer?: (
    item: MobileWorkspaceItem,
    answer: MobileAnswer
  ) => Promise<MobileAnswerFeedback>
  readonly onAsk?: (item: MobileWorkspaceItem) => void
  readonly onNext?: () => void
}

/** Returns the server-confirmed answer shape, excluding pending local state. */
function isScoredFeedback(
  feedback: MobileAnswerFeedback | null
): feedback is AnswerResponse {
  return feedback?.status === "correct" || feedback?.status === "incorrect"
}

/** Returns whether an explanation has enough distinct content for expansion. */
function isExpandableExplanation(item: MobileWorkspaceItem): boolean {
  const body = item.body?.trim() ?? ""
  const detail = item.deepExplanation?.trim() ?? ""
  return Boolean(detail && detail !== body && detail.length > 120)
}

/** Returns the visible choices for a stored item, including true-false items. */
function optionsForItem(item: MobileWorkspaceItem): Array<{
  readonly id: string
  readonly text: string
}> {
  if (item.type === "true-false") {
    return [
      { id: "true", text: "True" },
      { id: "false", text: "False" },
    ]
  }
  return item.options ?? []
}

/** Converts a visible option into the shared learning answer value. */
function answerForOption(
  item: MobileWorkspaceItem,
  optionId: string
): MobileAnswer {
  return item.type === "true-false" ? optionId === "true" : optionId
}

/** Returns the explanation text shown on the back of an explanation card. */
function detailedExplanation(item: MobileWorkspaceItem): string {
  return (
    item.deepExplanation?.trim() ||
    item.body?.trim() ||
    "A longer explanation is not available for this card yet."
  )
}

/** Renders one project walkthrough card with the same two-sided model as web. */
export function WalkthroughCard({
  item,
  conceptTitle,
  position,
  total,
  onAnswer,
  onAsk,
  onNext,
}: WalkthroughCardProps) {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedMany, setSelectedMany] = useState<string[]>([])
  const [feedback, setFeedback] = useState<MobileAnswerFeedback | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [flipped, setFlipped] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isExplanation = item.type === "explain"
  const isMultipleAnswer = item.type === "multiple-answer"
  const expandable = isExpandableExplanation(item)
  const options = optionsForItem(item)

  /** Resets local selection and card face state when the stage advances. */
  useEffect(() => {
    setSelected(null)
    setSelectedMany([])
    setFeedback(null)
    setPending(false)
    setError("")
    setFlipped(false)
    setExpanded(false)
  }, [item.id])

  /** Returns whether the server marked one displayed option as correct. */
  function optionIsCorrect(optionId: string): boolean {
    if (!isScoredFeedback(feedback) || !feedback.feedback) return false
    if (item.type === "true-false")
      return feedback.feedback.correctAnswer === (optionId === "true")
    if (item.type === "single-choice")
      return feedback.feedback.correctOptionId === optionId
    return feedback.feedback.correctOptionIds?.includes(optionId) === true
  }

  /** Asks the server to score an answer and leaves failed requests retryable. */
  async function scoreAnswer(answer: MobileAnswer): Promise<void> {
    if (!onAnswer || pending || feedback) return
    setPending(true)
    setError("")
    try {
      const result = await onAnswer(item, answer)
      if (result.status === "invalid") {
        setError(
          "reason" in result && result.reason
            ? result.reason
            : "That answer could not be checked. Try again."
        )
        return
      }
      setFeedback(result)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not check that answer."
      )
    } finally {
      setPending(false)
    }
  }

  /** Selects one option and submits immediately for single-answer formats. */
  function selectOption(optionId: string): void {
    if (pending || feedback) return
    if (isMultipleAnswer) {
      setSelectedMany((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
      )
      return
    }
    setSelected(optionId)
    void scoreAnswer(answerForOption(item, optionId))
  }

  /** Submits all selected choices for an exact multiple-answer response. */
  function submitMultiple(): void {
    if (!selectedMany.length || pending || feedback) return
    void scoreAnswer(selectedMany)
  }

  /** Renders the server response beneath the answer choices. */
  function renderFeedback(): ReactNode {
    if (!feedback) return null
    const label =
      feedback.status === "correct"
        ? "Correct"
        : feedback.status === "incorrect"
          ? "Not quite"
          : feedback.status === "pending"
            ? "Answer saved · waiting for sync"
            : "Answer could not be scored"
    const message =
      "feedback" in feedback
        ? feedback.feedback?.body
        : "reason" in feedback
          ? feedback.reason
          : undefined
    return (
      <View
        accessibilityLiveRegion="polite"
        style={[
          styles.feedback,
          feedback.status === "correct" && styles.feedbackCorrect,
          feedback.status === "incorrect" && styles.feedbackIncorrect,
        ]}
      >
        <Text style={styles.feedbackTitle}>{label}</Text>
        {message ? <Text style={styles.feedbackBody}>{message}</Text> : null}
      </View>
    )
  }

  /** Renders the compact front of the card, including answer controls. */
  function renderFront(): ReactNode {
    return (
      <View style={styles.face}>
        <View style={styles.cardTopline}>
          <Text style={styles.eyebrow}>
            {isExplanation ? "✦  Walkthrough" : "?  Quick check"}
          </Text>
          <Text style={styles.position}>
            {position + 1} of {total}
          </Text>
        </View>
        <Text style={styles.concept}>{conceptTitle}</Text>
        <Text style={styles.title}>
          {isExplanation ? item.title : (item.question ?? item.title)}
        </Text>
        {isExplanation ? (
          <View style={styles.markdown}>
            <Markdown text={item.body ?? ""} />
          </View>
        ) : (
          <View style={styles.options} accessibilityLabel="Answer options">
            {isMultipleAnswer ? (
              <Text style={styles.instruction}>Select all that apply</Text>
            ) : null}
            {options.map((option, index) => {
              const isSelected = isMultipleAnswer
                ? selectedMany.includes(option.id)
                : selected === option.id
              const scored = isScoredFeedback(feedback)
              const correct = scored && optionIsCorrect(option.id)
              const incorrect = scored && isSelected && !correct
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole={isMultipleAnswer ? "checkbox" : "radio"}
                  accessibilityState={{
                    checked: isSelected,
                    disabled: pending || Boolean(feedback),
                  }}
                  disabled={pending || Boolean(feedback)}
                  onPress={() => selectOption(option.id)}
                  style={({ pressed }) => [
                    styles.option,
                    isSelected && styles.optionSelected,
                    correct && styles.optionCorrect,
                    incorrect && styles.optionIncorrect,
                    pressed && styles.optionPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionMarker,
                      isSelected && styles.optionMarkerSelected,
                      correct && styles.optionMarkerCorrect,
                      incorrect && styles.optionMarkerIncorrect,
                    ]}
                  >
                    {correct
                      ? "✓"
                      : isMultipleAnswer && isSelected
                        ? "✓"
                        : item.type === "true-false"
                          ? option.text.slice(0, 1)
                          : String.fromCharCode(65 + index)}
                  </Text>
                  <Text style={styles.optionText}>{option.text}</Text>
                </Pressable>
              )
            })}
            {isMultipleAnswer && !feedback ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{
                  disabled: !selectedMany.length || pending,
                }}
                disabled={!selectedMany.length || pending}
                onPress={submitMultiple}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (!selectedMany.length || pending) && styles.disabledButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {pending ? "Checking…" : "Check answers"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        )}
        {renderFeedback()}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            disabled={!onAsk}
            onPress={() => onAsk?.(item)}
            style={({ pressed }) => [
              styles.secondaryButton,
              !onAsk && styles.disabledButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Ask Blitz</Text>
          </Pressable>
          <View style={styles.footerRight}>
            {isExplanation ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setFlipped(true)}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>See more detail</Text>
              </Pressable>
            ) : null}
            {onNext ? (
              <Pressable
                accessibilityRole="button"
                onPress={onNext}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>Next card</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        {item.sourceLabels.length ? (
          <Text style={styles.source}>{item.sourceLabels.join(" · ")}</Text>
        ) : null}
      </View>
    )
  }

  /** Renders the longer source-grounded explanation behind an explanation card. */
  function renderBack(): ReactNode {
    return (
      <View style={styles.face}>
        <View style={styles.cardTopline}>
          <Text style={styles.eyebrow}>✦ In-depth explanation</Text>
          <Text style={styles.position}>
            {position + 1} of {total}
          </Text>
        </View>
        <Text style={styles.concept}>{conceptTitle}</Text>
        <Text style={styles.title}>{item.title}</Text>
        <View
          style={[
            styles.markdown,
            expandable && !expanded && styles.collapsedExplanation,
          ]}
        >
          <Markdown text={detailedExplanation(item)} />
        </View>
        {expandable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}
            style={styles.showMore}
          >
            <Text style={styles.linkText}>
              {expanded ? "Show less" : "Show more"}
            </Text>
          </Pressable>
        ) : null}
        <Text style={styles.detailPrompt}>
          Want to connect this idea to the rest of your material?
        </Text>
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            disabled={!onAsk}
            onPress={() => onAsk?.(item)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Delve deeper</Text>
          </Pressable>
          <View style={styles.footerRight}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setFlipped(false)
                setExpanded(false)
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Show front</Text>
            </Pressable>
            {onNext ? (
              <Pressable
                accessibilityRole="button"
                onPress={onNext}
                style={styles.primaryButton}
              >
                <Text style={styles.primaryButtonText}>Next card</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        {item.sourceLabels.length ? (
          <Text style={styles.source}>{item.sourceLabels.join(" · ")}</Text>
        ) : null}
      </View>
    )
  }

  return (
    <View style={styles.card}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {flipped && isExplanation ? renderBack() : renderFront()}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 24,
    borderWidth: 1,
    maxHeight: 620,
    minHeight: 480,
    width: "100%",
  },
  scrollContent: { flexGrow: 1, padding: 20 },
  face: { flexGrow: 1, justifyContent: "space-between", gap: 15 },
  cardTopline: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: "#ff8065",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  position: { color: "#858585", fontSize: 12 },
  concept: { color: "#aaaaaa", fontSize: 14, fontWeight: "600", marginTop: 8 },
  title: { color: "#f7f7f7", fontSize: 27, fontWeight: "700", lineHeight: 32 },
  markdown: { gap: 9, marginTop: 2 },
  options: { gap: 10, marginTop: 2 },
  instruction: { color: "#aaaaaa", fontSize: 13, marginBottom: 2 },
  option: {
    alignItems: "center",
    backgroundColor: "#222222",
    borderColor: "#3a3a3a",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 11,
    minHeight: 54,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionSelected: { backgroundColor: "#ff806512", borderColor: "#ff806580" },
  optionCorrect: { backgroundColor: "#1c6b4230", borderColor: "#5dd59899" },
  optionIncorrect: { backgroundColor: "#8f302c30", borderColor: "#ff8c8699" },
  optionPressed: { opacity: 0.8 },
  optionMarker: {
    alignItems: "center",
    borderColor: "#4b4b4b",
    borderRadius: 9,
    borderWidth: 1,
    color: "#aaaaaa",
    fontSize: 12,
    fontWeight: "700",
    height: 29,
    paddingTop: 6,
    textAlign: "center",
    width: 29,
  },
  optionMarkerSelected: { borderColor: "#ff8065", color: "#ff8065" },
  optionMarkerCorrect: { borderColor: "#5dd598", color: "#5dd598" },
  optionMarkerIncorrect: { borderColor: "#ff8c86", color: "#ff8c86" },
  optionText: { color: "#e5e5e5", flex: 1, fontSize: 15, lineHeight: 21 },
  feedback: { borderRadius: 14, borderWidth: 1, gap: 4, padding: 13 },
  feedbackCorrect: { backgroundColor: "#1c6b4220", borderColor: "#5dd59866" },
  feedbackIncorrect: { backgroundColor: "#8f302c20", borderColor: "#ff8c8666" },
  feedbackTitle: { color: "#f7f7f7", fontSize: 15, fontWeight: "700" },
  feedbackBody: { color: "#bdbdbd", fontSize: 13, lineHeight: 19 },
  error: { color: "#ff8c86", fontSize: 13, lineHeight: 19 },
  footer: {
    alignItems: "center",
    borderTopColor: "#303030",
    borderTopWidth: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "space-between",
    paddingTop: 14,
  },
  footerRight: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#ff8065",
    borderRadius: 10,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 13,
  },
  primaryButtonText: { color: "#1b0d0a", fontSize: 13, fontWeight: "700" },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#222222",
    borderColor: "#424242",
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 12,
  },
  secondaryButtonText: { color: "#f7f7f7", fontSize: 13, fontWeight: "700" },
  pressed: { opacity: 0.8 },
  disabledButton: { opacity: 0.45 },
  source: { color: "#858585", fontSize: 12, lineHeight: 18 },
  collapsedExplanation: { maxHeight: 150, overflow: "hidden" },
  showMore: { alignSelf: "flex-start", paddingVertical: 3 },
  linkText: { color: "#ff8065", fontSize: 13, fontWeight: "700" },
  detailPrompt: { color: "#858585", fontSize: 13, lineHeight: 19 },
})
