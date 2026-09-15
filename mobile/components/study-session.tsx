/** Renders native practice and test sessions using the shared server-scored deck. */

import { useEffect, useMemo, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  getSessionProgress,
  makeAnswerSubmission,
  summarizeSessionResults,
  type SessionAnswer,
  type SessionAnswerResult,
  type SessionQuestion,
} from "../../lib/learning/session-contracts"
import { fetchStudySession, submitStudyAnswer } from "../lib/study"

/** The deliberate session modes offered by the project workspace. */
export type MobileStudySessionMode = "practice" | "test"

/** Props needed to render one native study or test route. */
export type MobileStudySessionProps = {
  readonly serverUrl: string
  readonly projectId: string
  readonly mode: MobileStudySessionMode
  readonly topicId?: string
  readonly onClose: () => void
}

/** Creates a stable local session identifier for retry-safe submissions. */
function createSessionId(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Returns the visible choices for a question, including true/false items. */
function sessionOptions(
  question: SessionQuestion
): readonly { id: string; text: string }[] {
  return question.type === "true-false"
    ? [
        { id: "true", text: "True" },
        { id: "false", text: "False" },
      ]
    : (question.options ?? [])
}

/** Returns whether one option is selected by a session answer. */
function isSelected(
  question: SessionQuestion,
  answer: SessionAnswer | undefined,
  optionId: string
): boolean {
  if (question.type === "multiple-answer")
    return Array.isArray(answer) && answer.includes(optionId)
  return question.type === "true-false"
    ? answer === (optionId === "true")
    : answer === optionId
}

/** Returns whether the server result marks one option as correct. */
function isCorrect(
  question: SessionQuestion,
  result: SessionAnswerResult | undefined,
  optionId: string
): boolean {
  if (!result?.feedback) return false
  if (question.type === "true-false")
    return result.feedback.correctAnswer === (optionId === "true")
  return (
    result.feedback.correctOptionId === optionId ||
    result.feedback.correctOptionIds?.includes(optionId) === true
  )
}

/** Renders one native practice/test activity and keeps scoring on the server. */
export function StudySession({
  serverUrl,
  projectId,
  mode,
  topicId,
  onClose,
}: MobileStudySessionProps) {
  const insets = useSafeAreaInsets()
  const [sessionId] = useState(createSessionId)
  const [startedAt] = useState(() => Date.now())
  const [questions, setQuestions] = useState<readonly SessionQuestion[]>()
  const [deckDone, setDeckDone] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [draftAnswer, setDraftAnswer] = useState<SessionAnswer>()
  const [testAnswers, setTestAnswers] = useState<
    Record<string, SessionAnswer | undefined>
  >({})
  const [practiceResults, setPracticeResults] = useState<
    Record<string, SessionAnswerResult | undefined>
  >({})
  const [testResults, setTestResults] = useState<
    Record<string, SessionAnswerResult | undefined>
  >({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [requestError, setRequestError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finished, setFinished] = useState(false)
  const [complete, setComplete] = useState(false)
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError("")
    void fetchStudySession(serverUrl, projectId, topicId, controller.signal)
      .then((page) => {
        setQuestions(page.items)
        setDeckDone(page.isDone)
        setCurrentIndex(0)
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") return
        setError(
          cause instanceof Error
            ? cause.message
            : "Questions could not be loaded"
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [projectId, serverUrl, topicId])

  const question = questions?.[currentIndex]
  const selectedAnswer =
    mode === "test"
      ? question
        ? testAnswers[question.itemId]
        : undefined
      : draftAnswer
  const practiceResult = question ? practiceResults[question.itemId] : undefined
  const progress = useMemo(
    () => getSessionProgress(questions ?? [], testAnswers),
    [questions, testAnswers]
  )

  /** Moves between questions and clears draft-only state. */
  function moveTo(index: number): void {
    if (!questions || index < 0 || index >= questions.length || locked) return
    setCurrentIndex(index)
    setDraftAnswer(undefined)
    setRequestError("")
  }

  /** Finishes practice locally after the last server-confirmed answer. */
  function advancePractice(): void {
    if (!questions || locked) return
    if (currentIndex >= questions.length - 1) {
      setComplete(true)
      return
    }
    moveTo(currentIndex + 1)
  }

  /** Posts one practice answer with the shared stable attempt identity. */
  async function submitPractice(answer: SessionAnswer): Promise<void> {
    if (!question || submitting || practiceResult) return
    setSubmitting(true)
    setRequestError("")
    try {
      const result = await submitStudyAnswer(
        serverUrl,
        projectId,
        makeAnswerSubmission(sessionId, question, answer, startedAt)
      )
      if (result.status === "invalid") {
        setRequestError(
          result.reason ?? "That answer could not be checked. Try again."
        )
      } else {
        setPracticeResults((current) => ({
          ...current,
          [question.itemId]: result,
        }))
      }
    } catch (cause) {
      setRequestError(
        cause instanceof Error ? cause.message : "Answer could not be saved"
      )
    } finally {
      setSubmitting(false)
    }
  }

  /** Stores a test selection or submits an immediate practice selection. */
  function chooseAnswer(answer: SessionAnswer): void {
    if (!question || submitting || practiceResult || locked) return
    if (mode === "test") {
      setTestAnswers((current) => ({ ...current, [question.itemId]: answer }))
      return
    }
    setDraftAnswer(answer)
    if (question.type !== "multiple-answer") void submitPractice(answer)
  }

  /** Toggles one option in a multiple-answer selection. */
  function toggleMultiple(optionId: string): void {
    const current = Array.isArray(selectedAnswer) ? selectedAnswer : []
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId]
    chooseAnswer(next)
  }

  /** Submits every answered test question and retains partial progress on failure. */
  async function finishTest(): Promise<void> {
    if (!questions || finishing) return
    setLocked(true)
    setFinishing(true)
    setRequestError("")
    const nextResults = { ...testResults }
    try {
      for (const candidate of questions) {
        const answer = testAnswers[candidate.itemId]
        if (answer === undefined || nextResults[candidate.itemId]) continue
        const result = await submitStudyAnswer(
          serverUrl,
          projectId,
          makeAnswerSubmission(sessionId, candidate, answer, startedAt)
        )
        if (result.status === "invalid")
          throw new Error("One answer could not be checked")
        nextResults[candidate.itemId] = result
        setTestResults({ ...nextResults })
      }
      setFinished(true)
    } catch (cause) {
      setRequestError(
        cause instanceof Error
          ? `${cause.message}. Finish again to retry the remaining answers.`
          : "Some answers could not be saved. Finish again to retry."
      )
    } finally {
      setFinishing(false)
    }
  }

  /** Retries the deck request after an explicit recovery action. */
  function retry(): void {
    setQuestions(undefined)
    setError("")
    setLoading(true)
    // Changing the topic key is unnecessary. Reusing the component's parent
    // route keeps retry behavior predictable and avoids a second request loop.
    void fetchStudySession(serverUrl, projectId, topicId)
      .then((page) => {
        setQuestions(page.items)
        setDeckDone(page.isDone)
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Questions could not be loaded"
        )
      )
      .finally(() => setLoading(false))
  }

  if (loading)
    return (
      <SessionStatus
        message="Loading questions…"
        onClose={onClose}
        insets={insets}
      />
    )
  if (error)
    return (
      <SessionStatus
        message={error}
        onClose={onClose}
        onRetry={retry}
        insets={insets}
      />
    )
  if (!questions?.length)
    return (
      <SessionStatus
        message={
          deckDone
            ? "There are no questions in this selection yet."
            : "No questions are ready here yet."
        }
        onClose={onClose}
        insets={insets}
      />
    )
  if (mode === "test" && finished)
    return (
      <TestResults
        questions={questions}
        answers={testAnswers}
        results={testResults}
        progress={progress}
        onClose={onClose}
        insets={insets}
      />
    )
  if (mode === "practice" && complete)
    return (
      <SessionStatus
        message="Practice session complete."
        onClose={onClose}
        insets={insets}
      />
    )
  if (!question)
    return (
      <SessionStatus
        message="This session has ended."
        onClose={onClose}
        insets={insets}
      />
    )

  const options = sessionOptions(question)
  const canCheckMultiple =
    question.type === "multiple-answer" &&
    Array.isArray(selectedAnswer) &&
    selectedAnswer.length > 0
  const isLast = currentIndex === questions.length - 1
  const testSelected = mode === "test" && selectedAnswer !== undefined

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.root}
    >
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={styles.headerButton}
        >
          <Text style={styles.headerButtonText}>Exit</Text>
        </Pressable>
        <Text style={styles.headerMeta}>
          {mode === "practice" ? "Study" : "Test"} · {currentIndex + 1} of{" "}
          {questions.length}
        </Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.prompt}>{question.prompt}</Text>
        {question.type === "multiple-answer" ? (
          <Text style={styles.instruction}>Select all that apply</Text>
        ) : null}
        <View style={styles.options} accessibilityLabel="Answer options">
          {options.map((option, index) => {
            const selected = isSelected(question, selectedAnswer, option.id)
            const correct = isCorrect(question, practiceResult, option.id)
            const incorrect = Boolean(practiceResult && selected && !correct)
            return (
              <Pressable
                key={option.id}
                accessibilityRole={
                  question.type === "multiple-answer" ? "checkbox" : "radio"
                }
                accessibilityState={{
                  checked: selected,
                  disabled: submitting || Boolean(practiceResult) || locked,
                }}
                disabled={submitting || Boolean(practiceResult) || locked}
                onPress={() =>
                  question.type === "multiple-answer"
                    ? toggleMultiple(option.id)
                    : chooseAnswer(
                        question.type === "true-false"
                          ? option.id === "true"
                          : option.id
                      )
                }
                style={({ pressed }) => [
                  styles.option,
                  selected && styles.optionSelected,
                  correct && styles.optionCorrect,
                  incorrect && styles.optionIncorrect,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.optionMarker,
                    selected && styles.optionMarkerSelected,
                  ]}
                >
                  {question.type === "multiple-answer"
                    ? selected
                      ? "✓"
                      : ""
                    : String.fromCharCode(65 + index)}
                </Text>
                <Text style={styles.optionText}>{option.text}</Text>
              </Pressable>
            )
          })}
        </View>
        {requestError ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {requestError}
          </Text>
        ) : null}
        {practiceResult ? <AnswerFeedback result={practiceResult} /> : null}
        <View style={styles.actions}>
          {mode === "test" && currentIndex > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={locked}
              onPress={() => moveTo(currentIndex - 1)}
              style={styles.quietButton}
            >
              <Text style={styles.quietText}>Back</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <View style={styles.actionGroup}>
            {mode === "test" && !isLast ? (
              <ActionButton
                label={testSelected ? "Next" : "Skip"}
                onPress={() => moveTo(currentIndex + 1)}
                disabled={locked}
              />
            ) : mode === "test" ? (
              <ActionButton
                label={
                  finishing
                    ? "Saving…"
                    : locked
                      ? "Retry remaining"
                      : "Finish test"
                }
                onPress={() => void finishTest()}
                disabled={finishing}
              />
            ) : question.type === "multiple-answer" && !practiceResult ? (
              <ActionButton
                label="Check answer"
                onPress={() => void submitPractice(selectedAnswer ?? [])}
                disabled={!canCheckMultiple || submitting}
              />
            ) : practiceResult ? (
              <ActionButton
                label={isLast ? "Finish" : "Next"}
                onPress={advancePractice}
                disabled={submitting}
              />
            ) : null}
            {mode === "practice" && !practiceResult ? (
              <Pressable
                accessibilityRole="button"
                disabled={submitting}
                onPress={advancePractice}
                style={styles.quietButton}
              >
                <Text style={styles.quietText}>Skip</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

/** Renders a recoverable loading, empty, or completed session state. */
function SessionStatus({
  message,
  onClose,
  onRetry,
  insets,
}: {
  readonly message: string
  readonly onClose: () => void
  readonly onRetry?: () => void
  readonly insets: { top: number; bottom: number }
}) {
  return (
    <View
      style={[
        styles.root,
        styles.statusRoot,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <Text accessibilityLiveRegion="polite" style={styles.statusText}>
        {message}
      </Text>
      {message.startsWith("Loading") ? (
        <ActivityIndicator color="#ff8065" style={styles.statusSpinner} />
      ) : null}
      <View style={styles.statusActions}>
        {onRetry ? <ActionButton label="Try again" onPress={onRetry} /> : null}
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={styles.quietButton}
        >
          <Text style={styles.quietText}>Back to project</Text>
        </Pressable>
      </View>
    </View>
  )
}

/** Renders one primary action with native touch and disabled states. */
function ActionButton({
  label,
  onPress,
  disabled,
}: {
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  )
}

/** Announces server feedback without revealing local guesses as correctness. */
function AnswerFeedback({ result }: { readonly result: SessionAnswerResult }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.feedback}>
      <Text
        style={[
          styles.feedbackTitle,
          result.status === "correct"
            ? styles.correctText
            : styles.incorrectText,
        ]}
      >
        {result.status === "correct"
          ? "Correct"
          : result.status === "incorrect"
            ? "Incorrect"
            : "Answer could not be scored"}
      </Text>
      {result.feedback?.body ? (
        <Text style={styles.feedbackBody}>{result.feedback.body}</Text>
      ) : null}
    </View>
  )
}

/** Renders the test summary and every server-returned result. */
function TestResults({
  questions,
  answers,
  results,
  progress,
  onClose,
  insets,
}: {
  readonly questions: readonly SessionQuestion[]
  readonly answers: Readonly<Record<string, SessionAnswer | undefined>>
  readonly results: Readonly<Record<string, SessionAnswerResult | undefined>>
  readonly progress: { total: number; answered: number; unanswered: number }
  readonly onClose: () => void
  readonly insets: { top: number; bottom: number }
}) {
  const summary = summarizeSessionResults(
    progress.total,
    Object.values(results).filter(
      (result): result is SessionAnswerResult => result !== undefined
    ),
    progress.unanswered
  )
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[
        styles.resultsContent,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onClose}
        style={styles.headerButton}
      >
        <Text style={styles.headerButtonText}>Exit</Text>
      </Pressable>
      <Text style={styles.resultsTitle}>Test results</Text>
      <Text style={styles.resultsMeta}>
        {summary.correct} correct · {summary.incorrect} incorrect ·{" "}
        {summary.unanswered} unanswered
      </Text>
      {questions.map((candidate, index) => {
        const result = results[candidate.itemId]
        return (
          <View key={candidate.itemId} style={styles.resultRow}>
            <Text style={styles.questionNumber}>Question {index + 1}</Text>
            <Text style={styles.resultPrompt}>{candidate.prompt}</Text>
            <Text style={styles.resultStatus}>
              {result
                ? result.status === "correct"
                  ? "Correct"
                  : result.status === "incorrect"
                    ? "Incorrect"
                    : "Could not score this answer"
                : "Unanswered"}
            </Text>
            {result ? (
              <View style={styles.resultOptions}>
                {sessionOptions(candidate).map((option) => {
                  const selected = isSelected(
                    candidate,
                    answers[candidate.itemId],
                    option.id
                  )
                  const correct = isCorrect(candidate, result, option.id)
                  return (
                    <Text
                      key={option.id}
                      style={[
                        styles.resultOption,
                        correct && styles.resultOptionCorrect,
                        selected && !correct && styles.resultOptionIncorrect,
                      ]}
                    >
                      {correct ? "✓ " : selected ? "× " : ""}
                      {option.text}
                    </Text>
                  )
                })}
              </View>
            ) : null}
            {result?.feedback?.body ? (
              <Text style={styles.feedbackBody}>{result.feedback.body}</Text>
            ) : null}
          </View>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#080808" },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerButton: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  headerButtonText: { color: "#ffffff", fontSize: 14 },
  headerMeta: { color: "#9c9c9c", fontSize: 13 },
  headerSpacer: { width: 64 },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  prompt: { color: "#ffffff", fontSize: 31, fontWeight: "500", lineHeight: 34 },
  instruction: { color: "#9c9c9c", fontSize: 13, marginTop: 18 },
  options: { gap: 10, marginTop: 20 },
  option: {
    alignItems: "center",
    backgroundColor: "#161616",
    borderColor: "#292929",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 58,
    paddingHorizontal: 14,
  },
  optionSelected: { backgroundColor: "#2a1713", borderColor: "#ff8065" },
  optionCorrect: { backgroundColor: "#123b26", borderColor: "#5fd48a" },
  optionIncorrect: { backgroundColor: "#3b1919", borderColor: "#ff756e" },
  optionMarker: {
    borderColor: "#454545",
    borderRadius: 9,
    borderWidth: 1,
    color: "#8e8e8e",
    fontSize: 12,
    height: 28,
    lineHeight: 26,
    marginRight: 12,
    textAlign: "center",
    width: 28,
  },
  optionMarkerSelected: {
    backgroundColor: "#ff8065",
    borderColor: "#ff8065",
    color: "#1b0d0a",
  },
  optionText: { color: "#eeeeee", flex: 1, fontSize: 15, lineHeight: 21 },
  actions: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 28,
  },
  actionGroup: { alignItems: "center", flexDirection: "row", gap: 8 },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#ff8065",
    borderRadius: 22,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 18,
  },
  primaryText: { color: "#1b0d0a", fontSize: 14, fontWeight: "600" },
  quietButton: {
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 10,
  },
  quietText: { color: "#b4b4b4", fontSize: 14 },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
  error: { color: "#ff9a89", fontSize: 14, lineHeight: 21, marginTop: 18 },
  feedback: { marginTop: 20 },
  feedbackTitle: { fontSize: 14, fontWeight: "600" },
  correctText: { color: "#7ee2a8" },
  incorrectText: { color: "#ff9a89" },
  feedbackBody: {
    color: "#9c9c9c",
    fontSize: 14,
    lineHeight: 21,
    marginTop: 6,
  },
  statusRoot: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  statusText: {
    color: "#eeeeee",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  statusSpinner: { marginTop: 18 },
  statusActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 24,
  },
  resultsContent: { paddingHorizontal: 20 },
  resultsTitle: {
    color: "#ffffff",
    fontSize: 32,
    fontWeight: "500",
    marginTop: 28,
  },
  resultsMeta: { color: "#9c9c9c", fontSize: 14, marginTop: 10 },
  resultRow: {
    borderTopColor: "#2c2c2c",
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 28,
    paddingTop: 18,
  },
  questionNumber: { color: "#777777", fontSize: 12 },
  resultPrompt: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "500",
    lineHeight: 23,
    marginTop: 7,
  },
  resultStatus: { color: "#b1b1b1", fontSize: 14, marginTop: 8 },
  resultOptions: { gap: 7, marginTop: 14 },
  resultOption: { color: "#b1b1b1", fontSize: 14, lineHeight: 20 },
  resultOptionCorrect: { color: "#7ee2a8" },
  resultOptionIncorrect: { color: "#ff9a89" },
})
