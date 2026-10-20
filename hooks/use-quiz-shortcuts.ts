"use client"

/**
 * Keyboard answering for quizzes: number keys 1 to 9 (and letters A to I on
 * lettered options) pick an option, and Enter checks the answer or, once the
 * card is answered, moves on. Quizzes in Teach, drills, and the Review feed all
 * use it. Keys are never taken while the learner is typing, except Enter in a
 * one-line answer box, which checks the answer.
 *
 * Scoping: every mounted quiz registers its element. Keys go to exactly one
 * quiz, the owner, chosen this way: a quiz that holds focus owns the keys;
 * otherwise the answerable quiz with the most of its height in the viewport
 * owns them (the first in the list when tied). A quiz that has been answered
 * only takes Enter, and only when it supplies `onAdvance`. Two quizzes on one
 * page therefore never both react to a key.
 *
 * The hook drives the controls that already exist (`[data-quiz-option]`,
 * `[data-quiz-check]`) by clicking them, so answering stays in one code path.
 */

import { useEffect, useRef, type RefObject } from "react"

/** What a quiz tells the shortcut scope about its current state. */
export type QuizShortcutOptions = {
  /** Whether the quiz still takes an answer; number keys and Enter only act then. */
  answerable: boolean
  /** Whether options carry letters, so the letter keys A to I pick them. */
  lettered: boolean
  /** Called on Enter after the quiz is answered, to move on. Omit when there is no next action. */
  onAdvance?: () => void
}

/** One mounted quiz as the shared listener sees it. */
type ShortcutScope = {
  element: HTMLElement
  options: { current: QuizShortcutOptions }
}

/** Every quiz currently mounted with the hook. */
const scopes = new Set<ShortcutScope>()
/** Whether the shared window listener is attached. */
let listening = false

/**
 * Tells whether a key event came from a place that takes typed text, where the
 * quiz shortcuts and the Teach `N` key must stay out of the way.
 * @param target The event target.
 * @returns True for inputs, textareas, selects, and contenteditable regions.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.closest(
      "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
    ) !== null
  )
}

/**
 * Measures how much of an element is inside the viewport vertically.
 * @param element The element to measure.
 * @returns Visible height in pixels; zero or below when the element is off screen.
 */
function visibleHeight(element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  return Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)
}

/**
 * Picks the quiz that should receive a key press, following the scoping rules in
 * the file comment.
 * @returns The owning scope, or undefined when no quiz should react.
 */
function findOwner(): ShortcutScope | undefined {
  const focused =
    document.activeElement?.closest<HTMLElement>("[data-quiz-scope]")
  if (focused) return [...scopes].find((scope) => scope.element === focused)

  let best: { scope: ShortcutScope; rank: number; height: number } | undefined
  for (const scope of scopes) {
    const { answerable, onAdvance } = scope.options.current
    if (!answerable && !onAdvance) continue
    const height = visibleHeight(scope.element)
    if (height <= 0) continue
    // An answerable quiz outranks an answered one that only offers Enter to advance.
    const rank = answerable ? 1 : 0
    if (
      !best ||
      rank > best.rank ||
      (rank === best.rank && height > best.height)
    ) {
      best = { scope, rank, height }
    }
  }
  return best?.scope
}

/**
 * Maps a key to the option index it selects.
 * @param key The `KeyboardEvent.key` value.
 * @param lettered Whether the letter keys A to I are allowed.
 * @returns Zero-based option index, or undefined when the key selects nothing.
 */
function optionIndexForKey(key: string, lettered: boolean): number | undefined {
  if (/^[1-9]$/.test(key)) return Number(key) - 1
  if (lettered && /^[a-i]$/i.test(key))
    return key.toLowerCase().charCodeAt(0) - 97
  return undefined
}

/**
 * Tells whether an element is disabled, either natively or through `aria-disabled`.
 * @param element The control to check.
 * @returns True when a click on the control would do nothing.
 */
function isDisabled(element: HTMLElement): boolean {
  return (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled") === "true"
  )
}

/** Elements that already react to Enter natively. */
const CONTROL_SELECTOR =
  "button, a, input, select, textarea, [role='button'], [role='radio'], [role='checkbox']"

/**
 * Handles Enter for the owning quiz. Enter on a focused control (other than a
 * quiz option) keeps its native activation; otherwise it checks the answer, or
 * advances when the quiz is already answered.
 * @param event The key event.
 * @param owner The quiz that owns the key.
 */
function handleEnter(event: KeyboardEvent, owner: ShortcutScope): void {
  const target = event.target instanceof Element ? event.target : document.body
  const onOption = target.closest("[data-quiz-option]") !== null
  const onControl = target.closest(CONTROL_SELECTOR) !== null
  if (onControl && !onOption) return

  const { answerable, onAdvance } = owner.options.current
  if (answerable) {
    const check =
      owner.element.querySelector<HTMLButtonElement>("[data-quiz-check]")
    if (check && !check.disabled) {
      event.preventDefault()
      check.click()
    }
    return
  }
  if (onAdvance) {
    event.preventDefault()
    onAdvance()
  }
}

/**
 * Enter in a one-line answer box (a blank, an output answer) checks the answer
 * once it can be checked, as a form would submit. Other keys stay with typing.
 * @param event The key event.
 * @returns True when the event came from such a box, handled or not.
 */
function handleFieldEnter(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement))
    return false
  const scope = event.target.closest<HTMLElement>("[data-quiz-scope]")
  if (!scope) return false
  const check = scope.querySelector<HTMLButtonElement>("[data-quiz-check]")
  if (check && !check.disabled) {
    event.preventDefault()
    check.click()
  }
  return true
}

/**
 * The single window keydown listener shared by all quizzes. It ignores modified
 * keys, typing, and keys another handler already took, then routes the rest to
 * the owning quiz.
 * @param event The keydown event from the window.
 */
function handleKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.repeat) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (handleFieldEnter(event)) return
  if (isTypingTarget(event.target)) return

  const owner = findOwner()
  if (!owner) return

  if (event.key === "Enter") {
    handleEnter(event, owner)
    return
  }
  const { answerable, lettered } = owner.options.current
  if (!answerable) return
  const index = optionIndexForKey(event.key, lettered)
  if (index === undefined) return
  const option =
    owner.element.querySelectorAll<HTMLElement>("[data-quiz-option]")[index]
  if (!option || isDisabled(option)) return
  event.preventDefault()
  option.click()
}

/** Attaches the shared listener when the first quiz mounts. */
function attachListener(): void {
  if (listening) return
  window.addEventListener("keydown", handleKeyDown)
  listening = true
}

/** Detaches the shared listener when the last quiz unmounts. */
function detachListenerIfIdle(): void {
  if (!listening || scopes.size > 0) return
  window.removeEventListener("keydown", handleKeyDown)
  listening = false
}

/**
 * Registers a quiz with the shared shortcut scope for as long as it is mounted.
 * The latest `options` are read at key time, so the quiz can change state
 * without re-registering. Does nothing when the ref is empty.
 * @param elementRef Ref to the quiz's root element, which carries `data-quiz-scope`.
 * @param options The quiz's current answering state.
 */
export function useQuizShortcuts(
  elementRef: RefObject<HTMLElement | null>,
  options: QuizShortcutOptions
): void {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const scope: ShortcutScope = { element, options: latest }
    scopes.add(scope)
    attachListener()
    return () => {
      scopes.delete(scope)
      detachListenerIfIdle()
    }
  }, [elementRef])
}
