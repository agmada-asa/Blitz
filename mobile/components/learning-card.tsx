/**
 * Renders one server-prepared learning card in the native vertical feed.
 * Correctness is supplied only through the parent's server-confirmed feedback.
 */

import { useEffect, useState } from "react"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { Pressable, ScrollView, StyleSheet, View } from "react-native"

import type {
  MobileAnswer,
  MobileAnswerFeedback,
  MobileLearningCard,
} from "../lib/contracts"
import { Text } from "./native-text"
import { QuestionView, type QuestionResult } from "./question-view"

/** Props required to render and submit one card's answer. */
export type LearningCardProps = {
  readonly card: MobileLearningCard
  readonly feedback?: MobileAnswerFeedback
  readonly onAnswer: (answer: MobileAnswer) => Promise<void>
  readonly onAsk: () => void
  readonly onSkip: () => void
}

/**
 * Converts the learner's answer from the question view into the value the
 * shared answer route expects: one option id for single choice, a boolean
 * for true or false, and a list for every other format.
 */
function answerValue(card: MobileLearningCard, answer: string[]): MobileAnswer {
  if (card.type === "single-choice") return answer[0] ?? ""
  if (card.type === "true-false") return answer[0] === "true"
  return answer
}

/** Turns server feedback into the answer key the question view marks against. */
export function questionResult(
  feedback: MobileAnswerFeedback | undefined
): QuestionResult | undefined {
  if (!feedback || (feedback.status !== "correct" && feedback.status !== "incorrect")) return undefined
  const key = feedback.feedback
  const correctOptionIds =
    key?.correctOptionIds ??
    (key?.correctOptionId
      ? [key.correctOptionId]
      : key?.correctAnswer !== undefined
        ? [String(key.correctAnswer)]
        : undefined)
  return {
    correct: feedback.status === "correct",
    ...(correctOptionIds ? { correctOptionIds } : {}),
    ...(key?.acceptedAnswers ? { acceptedAnswers: key.acceptedAnswers } : {}),
    ...(key?.body ? { explanation: key.body } : {}),
  }
}

/** Short, plain questions read as a large title; longer ones and code render as Markdown. */
function isTitleQuestion(question: string): boolean {
  return question.length <= 160 && !/```|\n|\$|\{\{/.test(question)
}

/** Renders a question or explanation card in the vertical feed. */
export function LearningCard({
  card,
  feedback,
  onAnswer,
  onAsk,
  onSkip,
}: LearningCardProps) {
  const insets = useSafeAreaInsets()
  const [sending, setSending] = useState(false)
  const [answerError, setAnswerError] = useState("")
  const [viewportHeight, setViewportHeight] = useState(0)
  const [contentHeight, setContentHeight] = useState(0)

  useEffect(() => {
    setSending(false)
    setAnswerError("")
  }, [card.id])

  /** Sends an answer and unlocks retry when it could not be saved. */
  async function submitAnswer(answer: string[]) {
    if (sending || feedback) return
    setAnswerError("")
    setSending(true)
    try {
      await onAnswer(answerValue(card, answer))
    } catch (error) {
      setAnswerError(
        error instanceof Error ? error.message : "Could not save answer. Try again."
      )
    } finally {
      setSending(false)
    }
  }

  const scored = feedback?.status === "correct" || feedback?.status === "incorrect"
  const titleQuestion = card.type !== "explain" && isTitleQuestion(card.question)

  return (
    <View
      style={[
        styles.card,
        { paddingTop: 88 + insets.top, paddingBottom: 96 + insets.bottom },
      ]}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled={contentHeight > viewportHeight + 1}
        onContentSizeChange={(_, height) => setContentHeight(height)}
        onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        scrollEnabled={contentHeight > viewportHeight + 1}
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        {card.type === "explain" ? (
          <>
            <Text style={styles.eyebrow}>Recap</Text>
            <Text style={styles.title}>{card.title}</Text>
            <Text style={styles.body}>{card.body}</Text>
          </>
        ) : (
          <>
            <Text style={styles.eyebrow}>{card.title}</Text>
            {titleQuestion ? <Text style={styles.title}>{card.question}</Text> : null}
            <View style={styles.question}>
              <QuestionView
                shape={{
                  type: card.type,
                  question: card.question,
                  options: card.options ?? [],
                  ...(card.prompts ? { prompts: card.prompts } : {}),
                }}
                showQuestion={!titleQuestion}
                result={questionResult(feedback)}
                pendingLabel={feedback?.status === "pending" ? "Answer saved · waiting for sync" : undefined}
                disabled={sending}
                onSubmit={(answer) => void submitAnswer(answer)}
              />
            </View>
          </>
        )}

        {feedback?.status === "invalid" ? <Feedback feedback={feedback} /> : null}
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
            <Text style={styles.skipButtonText}>{scored ? "Next" : "Skip"}</Text>
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
    backgroundColor: "transparent",
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
  eyebrow: {
    color: "#ff8065",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 10,
  },
  question: {
    marginTop: 18,
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
  optionCorrect: {
    backgroundColor: "#123b26",
    borderColor: "#5fd48a",
  },
  optionIncorrect: {
    backgroundColor: "#3b1919",
    borderColor: "#ff756e",
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
  optionLetterCorrect: {
    backgroundColor: "#5fd48a",
    borderColor: "#5fd48a",
    color: "#0b2516",
  },
  optionLetterIncorrect: {
    backgroundColor: "#ff756e",
    borderColor: "#ff756e",
    color: "#2b0d0d",
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
