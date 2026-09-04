/**
 * Renders one server-prepared learning card in the native vertical feed.
 * Correctness is supplied only through the parent's server-confirmed feedback.
 */

import { useEffect, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"

import type {
  MobileAnswer,
  MobileAnswerFeedback,
  MobileLearningCard,
} from "../lib/contracts"

/** Props required to render and submit one card's answer. */
export type LearningCardProps = {
  readonly card: MobileLearningCard
  readonly feedback?: MobileAnswerFeedback
  readonly onAnswer: (answer: MobileAnswer) => Promise<void>
  readonly onAsk: () => void
  readonly onSkip: () => void
}

/** Renders a choice or explanation card with a compact native interaction. */
export function LearningCard({
  card,
  feedback,
  onAnswer,
  onAsk,
  onSkip,
}: LearningCardProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [answerError, setAnswerError] = useState("")
  const isMultiple = card.type === "multiple-answer"
  const options =
    card.type === "true-false"
      ? [
          { id: "true", text: "True" },
          { id: "false", text: "False" },
        ]
      : (card.options ?? [])

  useEffect(() => {
    setSelected([])
    setSubmitted(false)
    setAnswerError("")
  }, [card.id])

  /** Persists an answer and unlocks retry when local storage rejects it. */
  async function submitAnswer(answer: MobileAnswer) {
    setAnswerError("")
    try {
      await onAnswer(answer)
      setAnswerError("")
    } catch (error) {
      setSubmitted(false)
      setAnswerError(
        error instanceof Error
          ? error.message
          : "Could not save answer. Try again."
      )
    }
  }

  /** Selects one option and immediately submits single-answer formats. */
  function selectOption(optionId: string) {
    if (
      submitted ||
      feedback?.status === "pending" ||
      feedback?.status === "correct" ||
      feedback?.status === "incorrect" ||
      feedback?.status === "invalid"
    )
      return
    if (isMultiple) {
      setSelected((current) =>
        current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId]
      )
      setSubmitted(false)
      return
    }
    setSelected([optionId])
    setSubmitted(true)
    void submitAnswer(
      card.type === "true-false" ? optionId === "true" : optionId
    )
  }

  /** Submits the complete selected set for a multiple-answer card. */
  function submitMultiple() {
    if (
      !selected.length ||
      submitted ||
      feedback?.status === "pending" ||
      feedback?.status === "correct" ||
      feedback?.status === "incorrect" ||
      feedback?.status === "invalid"
    )
      return
    setSubmitted(true)
    void submitAnswer(selected)
  }

  return (
    <View style={styles.card}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        {card.type === "explain" ? (
          <>
            <Text style={styles.title}>{card.title}</Text>
            <Text style={styles.body}>{card.body}</Text>
          </>
        ) : (
          <Text style={styles.title}>{card.question}</Text>
        )}

        {card.type !== "explain" ? (
          <>
            {isMultiple ? (
              <Text style={styles.instruction}>Select all that apply</Text>
            ) : null}
            <View style={styles.options} accessibilityLabel="Answer options">
              {options.map((option, index) => {
                const isSelected = selected.includes(option.id)
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole={isMultiple ? "checkbox" : "radio"}
                    accessibilityState={{ checked: isSelected }}
                    onPress={() => selectOption(option.id)}
                    style={({ pressed }) => [
                      styles.option,
                      isSelected && styles.optionSelected,
                      pressed && styles.optionPressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.optionLetter,
                        isSelected && styles.optionLetterSelected,
                      ]}
                    >
                      {isMultiple
                        ? isSelected
                          ? "✓"
                          : ""
                        : String.fromCharCode(65 + index)}
                    </Text>
                    <Text style={styles.optionText}>{option.text}</Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        ) : null}

        {isMultiple && !feedback ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              disabled: selected.length === 0 || submitted,
            }}
            disabled={!selected.length || submitted}
            onPress={submitMultiple}
            style={({ pressed }) => [
              styles.primaryButton,
              (!selected.length || submitted) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>Check answer</Text>
          </Pressable>
        ) : null}

        {feedback ? <Feedback feedback={feedback} /> : null}
        {answerError ? <Text style={styles.error}>{answerError}</Text> : null}

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            onPress={onAsk}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Ask in chat</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={onSkip}
            style={({ pressed }) => [
              styles.skipButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.skipButtonText}>
              {feedback?.status === "correct" ||
              feedback?.status === "incorrect"
                ? "Next"
                : "Skip"}
            </Text>
          </Pressable>
        </View>

        {card.sourceLabel ? (
          <Text style={styles.source}>{card.sourceLabel}</Text>
        ) : null}
      </ScrollView>
    </View>
  )
}

/** Announces only the server-confirmed outcome or an explicit pending state. */
function Feedback({ feedback }: { readonly feedback: MobileAnswerFeedback }) {
  const label =
    feedback.status === "correct"
      ? "Correct"
      : feedback.status === "incorrect"
        ? "Not quite"
        : feedback.status === "invalid"
          ? "Answer could not be scored"
          : "Answer saved · waiting for sync"
  return (
    <View accessibilityLiveRegion="polite" style={styles.feedback}>
      <Text
        style={[
          styles.feedbackLabel,
          feedback.status === "correct" && styles.feedbackCorrect,
          feedback.status === "incorrect" && styles.feedbackIncorrect,
        ]}
      >
        {label}
      </Text>
      {"feedback" in feedback && feedback.feedback?.body ? (
        <Text style={styles.feedbackMessage}>{feedback.feedback.body}</Text>
      ) : "reason" in feedback && feedback.reason ? (
        <Text style={styles.feedbackMessage}>{feedback.reason}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    backgroundColor: "#090909",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 76,
  },
  content: {
    flexGrow: 1,
    width: "100%",
    maxWidth: 680,
    alignSelf: "center",
    justifyContent: "center",
  },
  scroll: {
    flex: 1,
  },
  title: {
    color: "#ffffff",
    fontSize: 34,
    fontWeight: "600",
    lineHeight: 38,
  },
  body: {
    color: "#b3b3b3",
    fontSize: 17,
    lineHeight: 27,
    marginTop: 18,
  },
  options: {
    gap: 10,
    marginTop: 18,
  },
  instruction: {
    color: "#a0a0a0",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 18,
  },
  option: {
    alignItems: "center",
    backgroundColor: "#161616",
    borderColor: "#292929",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 58,
    paddingHorizontal: 15,
  },
  optionSelected: {
    backgroundColor: "#2a1713",
    borderColor: "#ff8065",
  },
  optionPressed: {
    opacity: 0.76,
  },
  optionLetter: {
    alignItems: "center",
    borderColor: "#454545",
    borderRadius: 10,
    borderWidth: 1,
    color: "#8e8e8e",
    display: "flex",
    fontSize: 12,
    height: 30,
    lineHeight: 28,
    marginRight: 13,
    textAlign: "center",
    width: 30,
  },
  optionLetterSelected: {
    backgroundColor: "#ff8065",
    borderColor: "#ff8065",
    color: "#1b0d0a",
  },
  optionText: {
    color: "#eeeeee",
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  primaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#ff8065",
    borderRadius: 20,
    marginTop: 18,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  primaryButtonText: {
    color: "#1b0d0a",
    fontSize: 14,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  feedback: {
    marginTop: 18,
  },
  feedbackLabel: {
    color: "#c4c4c4",
    fontSize: 14,
    fontWeight: "600",
  },
  feedbackCorrect: {
    color: "#7ee2a8",
  },
  feedbackIncorrect: {
    color: "#ff9a89",
  },
  feedbackMessage: {
    color: "#9c9c9c",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 5,
  },
  error: {
    color: "#ff9a89",
    fontSize: 13,
    lineHeight: 20,
    marginTop: 14,
  },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginTop: 22,
  },
  secondaryButton: {
    borderColor: "#353535",
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 17,
  },
  secondaryButtonText: {
    color: "#dddddd",
    fontSize: 14,
  },
  skipButton: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  skipButtonText: {
    color: "#8c8c8c",
    fontSize: 14,
  },
  source: {
    color: "#666666",
    fontSize: 12,
    marginTop: 20,
  },
})
