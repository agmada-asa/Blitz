/**
 * Collects and marks an answer to any question format Blitz asks: single
 * choice, multiple answer, true or false, cloze, ordering, matching, and code
 * output. The same component serves Teach lesson quizzes, drills, and the
 * home feed, so a format looks and behaves the same wherever it appears.
 *
 * It never decides correctness itself. The caller passes `result` once the
 * answer is scored (by the server for drills and the feed, by the lesson's
 * own quiz block for Teach), and the component marks each option, row, or
 * blank from the answer key in that result.
 */

import { useEffect, useMemo, useState } from "react"
import { Platform, Pressable, StyleSheet, View } from "react-native"

import {
  clozeDisplayText,
  initialStructuredAnswer,
  structuredAnswerReady,
  type QuizType,
} from "../../lib/interactive-blocks"
import { normalizeBlankAnswer, normalizeOutputAnswer } from "../../lib/learning/core"
import { inlineMathToText } from "../../lib/math-text"
import { colors, radius, TOUCH_TARGET } from "../lib/theme"
import { Markdown } from "./markdown"
import { Text, TextInput } from "./native-text"

/** What a question shows before it is answered; never includes the answer key. */
export type QuestionShape = {
  readonly type: QuizType
  readonly question: string
  /** Choices, ordering items in display order, or matching right-hand items. */
  readonly options: ReadonlyArray<{ readonly id: string; readonly text: string }>
  /** Matching only: the left-hand items. */
  readonly prompts?: readonly string[]
}

/** A scored answer and the key needed to mark it. */
export type QuestionResult = {
  readonly correct: boolean
  /** Correct option set, ordering sequence, or the match for each prompt. */
  readonly correctOptionIds?: readonly string[]
  /** Cloze: accepted answers per blank. Code output: one entry of outputs. */
  readonly acceptedAnswers?: ReadonlyArray<readonly string[]>
  /** Shown under the verdict; may be Markdown. */
  readonly explanation?: string
}

/** Props for one question. */
export type QuestionViewProps = {
  readonly shape: QuestionShape
  /** Set once scored; the view then locks and marks the answer. */
  readonly result?: QuestionResult
  /** The learner's recorded answer, when restoring an answered question. */
  readonly recordedAnswer?: readonly string[]
  /** Shows the question text; off when the caller draws it as a title. */
  readonly showQuestion?: boolean
  /** Shown instead of the verdict while an answer waits to sync. */
  readonly pendingLabel?: string
  /**
   * Submits the answer: option ids for choice formats ("true"/"false" for
   * true or false), ids in order for ordering, one option id per prompt for
   * matching, typed blanks for cloze, and the typed output for code output.
   */
  readonly onSubmit: (answer: string[]) => void
  /** Locks the inputs, for example while the answer is being sent. */
  readonly disabled?: boolean
}

/** Options shown for a true or false question. */
const TRUE_FALSE = [
  { id: "true", text: "True" },
  { id: "false", text: "False" },
]

/** Renders a question of any format with its answer controls and marking. */
export function QuestionView({
  shape,
  result,
  recordedAnswer,
  showQuestion = true,
  pendingLabel,
  onSubmit,
  disabled = false,
}: QuestionViewProps) {
  const locked = Boolean(result) || Boolean(pendingLabel) || disabled
  const options = shape.type === "true-false" ? TRUE_FALSE : shape.options
  const [selected, setSelected] = useState<string[]>(() => [...(recordedAnswer ?? [])])
  const [structured, setStructured] = useState<string[]>(() =>
    recordedAnswer?.length ? [...recordedAnswer] : initialStructuredAnswer({ ...shape, options: [...shape.options] })
  )
  // A new question (the same view reused in a list) starts from scratch.
  const identity = `${shape.type}:${shape.question}`
  useEffect(() => {
    setSelected([...(recordedAnswer ?? [])])
    setStructured(
      recordedAnswer?.length ? [...recordedAnswer] : initialStructuredAnswer({ ...shape, options: [...shape.options] })
    )
    // Only reset when the question itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  const questionText = shape.type === "cloze" ? clozeDisplayText(shape.question) : shape.question

  return (
    <View style={styles.root}>
      {showQuestion ? <Markdown text={questionText} /> : null}
      {shape.type === "single-choice" || shape.type === "true-false" || shape.type === "multiple-answer" ? (
        <ChoiceAnswer
          options={options}
          multiple={shape.type === "multiple-answer"}
          selected={selected}
          locked={locked}
          result={result}
          onToggle={(id) => {
            if (shape.type === "multiple-answer")
              setSelected((current) =>
                current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
              )
            else {
              setSelected([id])
              onSubmit([id])
            }
          }}
        />
      ) : shape.type === "ordering" ? (
        <OrderingAnswer
          options={shape.options}
          value={structured}
          locked={locked}
          result={result}
          onChange={setStructured}
        />
      ) : shape.type === "matching" ? (
        <MatchingAnswer
          prompts={shape.prompts ?? []}
          options={shape.options}
          value={structured}
          locked={locked}
          result={result}
          onChange={setStructured}
        />
      ) : shape.type === "cloze" ? (
        <ClozeAnswer value={structured} locked={locked} result={result} onChange={setStructured} />
      ) : (
        <OutputAnswer value={structured} locked={locked} result={result} onChange={setStructured} />
      )}

      {!locked && shape.type !== "single-choice" && shape.type !== "true-false" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{
            disabled:
              shape.type === "multiple-answer"
                ? !selected.length
                : !structuredAnswerReady(shape.type, structured),
          }}
          disabled={
            shape.type === "multiple-answer" ? !selected.length : !structuredAnswerReady(shape.type, structured)
          }
          onPress={() => onSubmit(shape.type === "multiple-answer" ? selected : structured)}
          style={({ pressed }) => [
            styles.check,
            (shape.type === "multiple-answer" ? !selected.length : !structuredAnswerReady(shape.type, structured)) &&
              styles.disabled,
            pressed && styles.pressed,
          ]}
        >
          <Text style={styles.checkText}>{shape.type === "multiple-answer" ? "Check answers" : "Check answer"}</Text>
        </Pressable>
      ) : null}

      {result ? (
        <View accessibilityLiveRegion="polite" style={styles.verdict}>
          <Text style={[styles.verdictLabel, result.correct ? styles.correctText : styles.incorrectText]}>
            {result.correct ? "Correct" : "Not quite"}
          </Text>
          {result.explanation ? <Markdown text={result.explanation} /> : null}
        </View>
      ) : pendingLabel ? (
        <Text accessibilityLiveRegion="polite" style={styles.pending}>
          {pendingLabel}
        </Text>
      ) : null}
    </View>
  )
}

/** Choice rows for single choice, multiple answer, and true or false. */
function ChoiceAnswer({
  options,
  multiple,
  selected,
  locked,
  result,
  onToggle,
}: {
  readonly options: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly multiple: boolean
  readonly selected: readonly string[]
  readonly locked: boolean
  readonly result?: QuestionResult
  readonly onToggle: (id: string) => void
}) {
  const correctSet = new Set(result?.correctOptionIds ?? [])
  return (
    <View accessibilityRole={multiple ? undefined : "radiogroup"} style={styles.list}>
      {multiple ? <Text style={styles.hint}>Select all that apply</Text> : null}
      {options.map((option, index) => {
        const isSelected = selected.includes(option.id)
        const isCorrect = Boolean(result) && correctSet.has(option.id)
        const isWrong = Boolean(result) && isSelected && !correctSet.has(option.id)
        return (
          <Pressable
            key={option.id}
            accessibilityRole={multiple ? "checkbox" : "radio"}
            accessibilityState={{ checked: isSelected, disabled: locked }}
            accessibilityLabel={`${option.text}${isCorrect ? ", correct answer" : isWrong ? ", incorrect" : ""}`}
            disabled={locked}
            onPress={() => onToggle(option.id)}
            style={({ pressed }) => [
              styles.option,
              isSelected && styles.optionSelected,
              isCorrect && styles.optionCorrect,
              isWrong && styles.optionWrong,
              pressed && styles.pressed,
            ]}
          >
            <Text
              style={[
                styles.badge,
                isSelected && styles.badgeSelected,
                isCorrect && styles.badgeCorrect,
                isWrong && styles.badgeWrong,
              ]}
            >
              {multiple ? (isSelected ? "✓" : "") : String.fromCharCode(65 + index)}
            </Text>
            <Text style={styles.optionText}>{inlineMathToText(option.text)}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** Reorders items with move up and move down buttons; marks each position once scored. */
function OrderingAnswer({
  options,
  value,
  locked,
  result,
  onChange,
}: {
  readonly options: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly value: readonly string[]
  readonly locked: boolean
  readonly result?: QuestionResult
  readonly onChange: (value: string[]) => void
}) {
  const text = useMemo(
    () => new Map(options.map((option) => [option.id, inlineMathToText(option.text)])),
    [options]
  )
  const key = result?.correctOptionIds

  /** Swaps the item at `index` with its neighbour in `direction`. */
  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <View style={styles.list}>
      <Text style={styles.hint}>Put these in order, first at the top</Text>
      {value.map((id, index) => {
        const right = key ? key[index] === id : undefined
        return (
          <View
            key={id}
            style={[styles.row, right === true && styles.optionCorrect, right === false && styles.optionWrong]}
          >
            <Text style={styles.rowNumber}>{index + 1}</Text>
            <Text style={[styles.optionText, styles.rowText]}>{text.get(id) ?? id}</Text>
            {!locked ? (
              <View style={styles.moveButtons}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${text.get(id) ?? "item"} up`}
                  disabled={index === 0}
                  onPress={() => move(index, -1)}
                  style={({ pressed }) => [styles.moveButton, index === 0 && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.moveText}>↑</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${text.get(id) ?? "item"} down`}
                  disabled={index === value.length - 1}
                  onPress={() => move(index, 1)}
                  style={({ pressed }) => [
                    styles.moveButton,
                    index === value.length - 1 && styles.disabled,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.moveText}>↓</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )
      })}
      {result && !result.correct && key ? (
        <View style={styles.key}>
          <Text style={styles.keyLabel}>Correct order</Text>
          {key.map((id, index) => (
            <Text key={id} style={styles.keyText}>
              {index + 1}. {text.get(id) ?? id}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** Pairs each prompt with one option by tapping a chip; marks each pair once scored. */
function MatchingAnswer({
  prompts,
  options,
  value,
  locked,
  result,
  onChange,
}: {
  readonly prompts: readonly string[]
  readonly options: ReadonlyArray<{ readonly id: string; readonly text: string }>
  readonly value: readonly string[]
  readonly locked: boolean
  readonly result?: QuestionResult
  readonly onChange: (value: string[]) => void
}) {
  const text = new Map(options.map((option) => [option.id, inlineMathToText(option.text)]))
  const key = result?.correctOptionIds
  return (
    <View style={styles.list}>
      <Text style={styles.hint}>Match each item on the left to one answer</Text>
      {prompts.map((prompt, index) => {
        const chosen = value[index] ?? ""
        const right = key ? key[index] === chosen : undefined
        return (
          <View
            key={`${index}:${prompt}`}
            style={[styles.matchRow, right === true && styles.optionCorrect, right === false && styles.optionWrong]}
          >
            <Text style={styles.matchPrompt}>{inlineMathToText(prompt)}</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel={`Match for ${prompt}`} style={styles.chips}>
              {options.map((option) => {
                const isChosen = chosen === option.id
                // Once scored, only the chosen and the correct options stay visible.
                if (locked && !isChosen && !(key && key[index] === option.id)) return null
                const isKey = Boolean(key) && key?.[index] === option.id
                return (
                  <Pressable
                    key={option.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isChosen, disabled: locked }}
                    disabled={locked}
                    onPress={() => {
                      const next = [...value]
                      next[index] = option.id
                      onChange(next)
                    }}
                    style={({ pressed }) => [
                      styles.chip,
                      isChosen && styles.chipChosen,
                      locked && isKey && styles.chipKey,
                      locked && isChosen && !isKey && styles.chipWrong,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={[styles.chipText, isChosen && !locked && styles.chipTextChosen]}>
                      {inlineMathToText(option.text)}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
            {right === false && key ? (
              <Text style={styles.keyText}>Matches {text.get(key[index]) ?? key[index]}</Text>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

/** One text field per blank; marks each blank against its accepted answers once scored. */
function ClozeAnswer({
  value,
  locked,
  result,
  onChange,
}: {
  readonly value: readonly string[]
  readonly locked: boolean
  readonly result?: QuestionResult
  readonly onChange: (value: string[]) => void
}) {
  return (
    <View style={styles.list}>
      {value.map((entry, index) => {
        const accepted = result?.acceptedAnswers?.[index]
        const right = accepted
          ? accepted.some((answer) => normalizeBlankAnswer(answer) === normalizeBlankAnswer(entry))
          : undefined
        return (
          <View key={index} style={styles.blank}>
            <Text style={styles.blankLabel}>Blank {index + 1}</Text>
            <TextInput
              accessibilityLabel={`Blank ${index + 1}`}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!locked}
              onChangeText={(text) => {
                const next = [...value]
                next[index] = text
                onChange(next)
              }}
              placeholder="Type your answer"
              placeholderTextColor={colors.faint}
              style={[styles.input, right === true && styles.optionCorrect, right === false && styles.optionWrong]}
              value={entry}
            />
            {right === false && accepted ? (
              <Text style={styles.keyText}>Accepted: {accepted.join(" or ")}</Text>
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

/** A monospace field for a program's printed output; shows the expected output when wrong. */
function OutputAnswer({
  value,
  locked,
  result,
  onChange,
}: {
  readonly value: readonly string[]
  readonly locked: boolean
  readonly result?: QuestionResult
  readonly onChange: (value: string[]) => void
}) {
  const expected = result?.acceptedAnswers?.[0]
  const right = expected
    ? expected.some((answer) => normalizeOutputAnswer(answer) === normalizeOutputAnswer(value[0] ?? ""))
    : undefined
  return (
    <View style={styles.list}>
      <Text style={styles.hint}>Type exactly what the program prints</Text>
      <TextInput
        accessibilityLabel="Program output"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!locked}
        multiline
        onChangeText={(text) => onChange([text])}
        placeholder="Output"
        placeholderTextColor={colors.faint}
        style={[
          styles.input,
          styles.output,
          right === true && styles.optionCorrect,
          right === false && styles.optionWrong,
        ]}
        textAlignVertical="top"
        value={value[0] ?? ""}
      />
      {right === false && expected?.[0] !== undefined ? (
        <View style={styles.key}>
          <Text style={styles.keyLabel}>Expected output</Text>
          <Text style={[styles.keyText, styles.mono]}>{expected[0]}</Text>
        </View>
      ) : null}
    </View>
  )
}

const mono = Platform.OS === "ios" ? "Menlo" : "monospace"

const styles = StyleSheet.create({
  root: { gap: 14 },
  list: { gap: 10 },
  hint: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  option: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  optionSelected: { backgroundColor: colors.brandTint, borderColor: colors.brand },
  optionCorrect: { backgroundColor: colors.correctTint, borderColor: colors.correct },
  optionWrong: { backgroundColor: colors.incorrectTint, borderColor: colors.incorrect },
  badge: {
    borderColor: "#454545",
    borderRadius: radius.sm,
    borderWidth: 1,
    color: "#8e8e8e",
    fontSize: 12,
    height: 28,
    lineHeight: 26,
    marginRight: 12,
    textAlign: "center",
    width: 28,
  },
  badgeSelected: { backgroundColor: colors.brand, borderColor: colors.brand, color: colors.brandForeground },
  badgeCorrect: { backgroundColor: colors.correct, borderColor: colors.correct, color: "#0b2516" },
  badgeWrong: { backgroundColor: colors.incorrect, borderColor: colors.incorrect, color: "#2b0d0d" },
  optionText: { color: "#eeeeee", flex: 1, fontSize: 15, lineHeight: 22 },
  check: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 20,
  },
  checkText: { color: colors.brandForeground, fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  verdict: { gap: 6 },
  verdictLabel: { fontSize: 15, fontWeight: "700" },
  correctText: { color: "#7ee2a8" },
  incorrectText: { color: "#ff9a89" },
  pending: { color: colors.mutedForeground, fontSize: 14 },
  row: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 54,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
  },
  rowNumber: { color: colors.mutedForeground, fontSize: 13, fontWeight: "600", width: 18 },
  rowText: { paddingVertical: 6 },
  moveButtons: { flexDirection: "row" },
  moveButton: {
    alignItems: "center",
    height: TOUCH_TARGET,
    justifyContent: "center",
    width: TOUCH_TARGET,
  },
  moveText: { color: colors.text, fontSize: 18 },
  key: { gap: 4, marginTop: 4 },
  keyLabel: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  keyText: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  mono: { fontFamily: mono },
  matchRow: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  matchPrompt: { color: colors.foreground, fontSize: 15, fontWeight: "600", lineHeight: 21 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipChosen: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipKey: { backgroundColor: colors.correctTint, borderColor: colors.correct },
  chipWrong: { backgroundColor: colors.incorrectTint, borderColor: colors.incorrect },
  chipText: { color: colors.text, fontSize: 14 },
  chipTextChosen: { color: colors.brandForeground, fontWeight: "600" },
  blank: { gap: 6 },
  blankLabel: { color: colors.mutedForeground, fontSize: 12, fontWeight: "600" },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 15,
    minHeight: TOUCH_TARGET + 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  output: { fontFamily: mono, fontSize: 14, minHeight: 110 },
})
