/**
 * Answer feedback shared by inline quizzes, structured answers, and Review feed
 * cards: a brief pulse on a correct answer, a short shake on a wrong one, and a
 * light vibration on phones. The cues are CSS classes whose keyframes live in
 * `app/globals.css`. Each runs once when its class is added, so callers apply
 * a cue only on the render where an answer is freshly checked, never when a
 * recorded answer loads. Reduced motion turns off both the animation and the
 * vibration; neither changes what the learner can read or press.
 */

/** Outcome of a checked answer that drives the feedback cue. */
export type AnswerCue = "correct" | "wrong"

/**
 * Returns the CSS class that plays an answer cue.
 * @param cue The checked outcome, or undefined when no cue should play.
 * @returns `answer-pulse` for a correct answer, `answer-shake` for a wrong one, otherwise undefined.
 */
export function answerCueClass(cue: AnswerCue | undefined): string | undefined {
  if (cue === "correct") return "answer-pulse"
  if (cue === "wrong") return "answer-shake"
  return undefined
}

/**
 * Buzzes a phone briefly after a checked answer. Does nothing where the Vibration
 * API is missing (desktop browsers, iOS Safari) or when the learner prefers
 * reduced motion.
 * @param correct Whether the answer was correct. Wrong answers get a double buzz.
 */
export function vibrateForAnswer(correct: boolean): void {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.vibrate !== "function"
  )
    return
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
  navigator.vibrate(correct ? 15 : [30, 40, 30])
}
