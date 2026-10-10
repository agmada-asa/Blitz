/**
 * Defines the interactive Markdown block protocol shared by model prompts, the server, and web renderers.
 *
 * Tutors and chat replies embed quizzes, step-by-step worked examples, sandboxed visualisations, and
 * follow-up suggestions as fenced code blocks (```quiz, ```steps, ```viz, ```followups). This module
 * parses and validates those fences into normalized blocks, finds quizzes in stored messages for
 * server-side scoring, summarizes blocks for read-aloud, builds the sandboxed visualisation document,
 * and documents the protocol for model instructions. It has no React or browser dependencies so it can
 * run in route handlers and Node tests.
 */
import { lexer, type Token, type Tokens } from "marked"
import {
  countClozeBlanks,
  evaluateAnswer,
  type Question,
} from "./learning/core.ts"

/** Fence languages that render as interactive blocks instead of code. */
export const INTERACTIVE_BLOCK_LANGUAGES = [
  "quiz",
  "steps",
  "viz",
  "followups",
] as const

/** One of the fence languages listed in `INTERACTIVE_BLOCK_LANGUAGES`. */
export type InteractiveBlockLanguage =
  (typeof INTERACTIVE_BLOCK_LANGUAGES)[number]

/** A quiz choice with a stable normalized id ("a", "b", … or "true" / "false"). */
export type QuizOption = { id: string; text: string }

/** Every quiz format. Choice formats submit option ids; the rest submit a list of strings. */
export type QuizType =
  | "single-choice"
  | "multiple-answer"
  | "true-false"
  | "cloze"
  | "ordering"
  | "matching"
  | "code-output"

/**
 * A validated quiz with normalized options. `correctOptionIds` always
 * references `options` ids: the correct set for choice questions, every id in
 * the correct order for ordering, and the matching id per prompt for matching.
 * Cloze and code output leave it empty and use `acceptedAnswers`.
 */
export type QuizBlock = {
  kind: "quiz"
  /** Model-assigned id, unique within a message, 1–64 characters of `[A-Za-z0-9_-]`. */
  id: string
  /** Concept the question checks, used for progress tracking. */
  concept: string
  type: QuizType
  /** Markdown prompt. Cloze prompts mark blanks as `{{1}}`, `{{2}}`, … */
  question: string
  /** Choices, ordering items in display order, or matching right-hand items. */
  options: QuizOption[]
  correctOptionIds: string[]
  /** Matching only: left-hand items, each answered with one option id. */
  prompts?: string[]
  /** Cloze: accepted answers per blank. Code output: one entry of accepted outputs. */
  acceptedAnswers?: string[][]
  /** Markdown explanation shown after answering. */
  explanation: string
}

/** A worked example revealed one step at a time; step bodies are Markdown. */
export type StepsBlock = {
  kind: "steps"
  title?: string
  steps: Array<{ title?: string; body: string }>
}

/** Model-authored HTML that must only ever render inside a sandboxed iframe. */
export type VizBlock = { kind: "viz"; title?: string; html: string }

/** Suggested follow-up prompts the learner can send with one click. */
export type FollowupsBlock = { kind: "followups"; items: string[] }

/** Any validated interactive block. */
export type InteractiveBlock =
  QuizBlock | StepsBlock | VizBlock | FollowupsBlock

/** Parse result; `error` explains the first validation failure for logs and debugging. */
export type ParsedInteractiveBlock =
  { ok: true; block: InteractiveBlock } | { ok: false; error: string }

/** Upper bound on raw `viz` HTML so a runaway reply cannot create an unbounded iframe document. */
export const VIZ_HTML_MAX_CHARS = 60_000

/** Limits that keep blocks readable and bounded; exported so prompts and tests agree with parsing. */
export const INTERACTIVE_BLOCK_LIMITS = {
  quizIdPattern: /^[A-Za-z0-9_-]{1,64}$/,
  conceptChars: 120,
  questionChars: 1000,
  optionChars: 1000,
  explanationChars: 2000,
  minOptions: 2,
  maxOptions: 6,
  maxSteps: 12,
  stepBodyChars: 4000,
  stepTitleChars: 200,
  titleChars: 200,
  maxFollowups: 4,
  followupChars: 120,
  minOrderItems: 3,
  maxOrderItems: 8,
  minPairs: 3,
  maxPairs: 6,
  maxMatchExtras: 2,
  maxBlanks: 6,
  maxAcceptedAnswers: 6,
  blankAnswerChars: 200,
  outputChars: 1000,
} as const

/**
 * Narrows a lowercase fence language to a supported interactive block language.
 * @param language First word of a fence info string, already lowercased by the caller.
 * @returns True when the fence should be parsed as an interactive block.
 */
export function isInteractiveBlockLanguage(
  language: string
): language is InteractiveBlockLanguage {
  return (INTERACTIVE_BLOCK_LANGUAGES as readonly string[]).includes(language)
}

/**
 * Splits a fence info string into its language (first word, lowercased) and optional title (the rest).
 * @param infoString Full info string, for example "viz Recursion tree".
 * @returns The language and a whitespace-collapsed title, or no title when nothing follows the language.
 */
export function splitFenceInfo(infoString: string): {
  language: string
  title?: string
} {
  const trimmed = infoString.trim()
  const match = /^(\S*)\s*([\s\S]*)$/.exec(trimmed)
  const language = (match?.[1] ?? "").toLowerCase()
  const title = (match?.[2] ?? "").replace(/\s+/g, " ").trim()
  return {
    language,
    title: title
      ? title.slice(0, INTERACTIVE_BLOCK_LIMITS.titleChars)
      : undefined,
  }
}

/** Thrown by field validators; converted to `{ ok: false }` at the parse boundary. */
class BlockValidationError extends Error {}

/**
 * Validates a required string field after trimming.
 * @param value Untrusted value from model JSON.
 * @param field Field name used in the error message.
 * @param max Maximum trimmed length.
 * @returns The trimmed string.
 * @throws BlockValidationError when the value is not a non-empty string within the limit.
 */
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string")
    throw new BlockValidationError(`${field} must be a string`)
  const text = value.trim()
  if (!text) throw new BlockValidationError(`${field} must not be empty`)
  if (text.length > max)
    throw new BlockValidationError(`${field} must be at most ${max} characters`)
  return text
}

/**
 * Validates an optional string field, treating missing, null, and blank values as absent.
 * @param value Untrusted value from model JSON.
 * @param field Field name used in the error message.
 * @param max Maximum trimmed length.
 * @returns The trimmed string, or undefined when absent or blank.
 * @throws BlockValidationError when present but not a string, or longer than the limit.
 */
function optionalText(
  value: unknown,
  field: string,
  max: number
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string")
    throw new BlockValidationError(`${field} must be a string`)
  const text = value.trim()
  if (!text) return undefined
  if (text.length > max)
    throw new BlockValidationError(`${field} must be at most ${max} characters`)
  return text
}

/**
 * Parses a fence body as JSON.
 * @param source Raw fence body.
 * @returns The parsed value.
 * @throws BlockValidationError when the body is not valid JSON.
 */
function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    throw new BlockValidationError("body is not valid JSON")
  }
}

/**
 * Asserts that a value is a plain JSON object.
 * @param value Parsed JSON value.
 * @param label Block label used in the error message.
 * @returns The value typed as a record.
 * @throws BlockValidationError for arrays, null, and primitives.
 */
function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BlockValidationError(`${label} must be a JSON object`)
  return value as Record<string, unknown>
}

/**
 * Returns the normalized option id for a zero-based index ("a", "b", …).
 * @param index Zero-based option index, below `maxOptions`.
 * @returns A single lowercase letter.
 */
function optionId(index: number): string {
  return String.fromCharCode(97 + index)
}

/**
 * Validates that a value is an in-range integer option index.
 * @param value Untrusted index from model JSON.
 * @param optionCount Number of available options.
 * @returns The index.
 * @throws BlockValidationError when the value is not an integer within range.
 */
function optionIndex(value: unknown, optionCount: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= optionCount
  )
    throw new BlockValidationError(
      `answer must reference an option index from 0 to ${optionCount - 1}`
    )
  return value
}

/**
 * Hashes text to a 32-bit seed (FNV-1a) so a quiz shuffles the same way on
 * every parse, in the browser and on the server.
 * @param text Text to hash.
 * @returns An unsigned 32-bit integer.
 */
function seedFrom(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Returns a deterministic, never-identity permutation of a list, seeded by
 * text. Ordering and matching questions are written in answer order, so the
 * displayed order must differ from it.
 * @param items Items in answer order; at least two for a non-identity result.
 * @param seedText Text that fixes the permutation.
 * @returns A new array in display order.
 */
export function stableShuffle<T>(items: readonly T[], seedText: string): T[] {
  const result = [...items]
  let state = seedFrom(seedText) || 1
  /** Mulberry32 step returning a float in [0, 1). */
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  // A shuffle that lands on the answer order gives the answer away; rotate it.
  if (result.length > 1 && result.every((item, index) => item === items[index]))
    result.push(result.shift()!)
  return result
}

/**
 * Validates one accepted-answer entry: a string or a list of alternatives.
 * @param value Untrusted value from model JSON.
 * @param field Field name used in error messages.
 * @param max Maximum characters per alternative.
 * @returns One to `maxAcceptedAnswers` distinct trimmed alternatives.
 * @throws BlockValidationError when the entry is empty, too long, or not text.
 */
function acceptedList(value: unknown, field: string, max: number): string[] {
  const limits = INTERACTIVE_BLOCK_LIMITS
  const raw = Array.isArray(value) ? value : [value]
  if (raw.length < 1 || raw.length > limits.maxAcceptedAnswers)
    throw new BlockValidationError(
      `${field} must list 1 to ${limits.maxAcceptedAnswers} accepted answers`
    )
  const answers = raw.map((entry, index) =>
    requiredText(entry, `${field}[${index}]`, max)
  )
  return [...new Set(answers)]
}

/**
 * Validates the formats answered with a list of strings: cloze, ordering,
 * matching, and code output.
 * @param data Parsed quiz object.
 * @param base Shared validated fields.
 * @returns The normalized quiz block.
 * @throws BlockValidationError describing the first invalid field.
 */
function parseStructuredQuiz(
  data: Record<string, unknown>,
  base: Pick<QuizBlock, "kind" | "id" | "concept" | "question" | "explanation">
): QuizBlock {
  const limits = INTERACTIVE_BLOCK_LIMITS
  const type = data.type
  if (type === "cloze") {
    const blanks = countClozeBlanks(base.question)
    if (blanks < 1 || blanks > limits.maxBlanks)
      throw new BlockValidationError(
        `a cloze question needs 1 to ${limits.maxBlanks} blanks written {{1}}, {{2}}, …`
      )
    for (let number = 1; number <= blanks; number += 1)
      if (!new RegExp(`\\{\\{\\s*${number}\\s*\\}\\}`).test(base.question))
        throw new BlockValidationError("cloze blanks must be numbered from {{1}} without gaps")
    const answer =
      blanks === 1 && !Array.isArray(data.answer) ? [data.answer] : data.answer
    // A single blank may list its alternatives directly: ["O(n)", "linear"].
    const entries =
      blanks === 1 && Array.isArray(answer) && answer.every((entry) => typeof entry === "string")
        ? [answer]
        : answer
    if (!Array.isArray(entries) || entries.length !== blanks)
      throw new BlockValidationError("answer must give accepted answers for each blank")
    return {
      ...base,
      type,
      options: [],
      correctOptionIds: [],
      acceptedAnswers: entries.map((entry, index) =>
        acceptedList(entry, `answer[${index}]`, limits.blankAnswerChars)
      ),
    }
  }
  if (type === "code-output") {
    if (!/```|~~~/.test(base.question))
      throw new BlockValidationError("a code-output question must include a fenced code block")
    return {
      ...base,
      type,
      options: [],
      correctOptionIds: [],
      acceptedAnswers: [acceptedList(data.answer, "answer", limits.outputChars)],
    }
  }
  if (type === "ordering") {
    if (
      !Array.isArray(data.options) ||
      data.options.length < limits.minOrderItems ||
      data.options.length > limits.maxOrderItems
    )
      throw new BlockValidationError(
        `options must list ${limits.minOrderItems} to ${limits.maxOrderItems} items in the correct order`
      )
    const texts = data.options.map((option, index) =>
      requiredText(option, `options[${index}]`, limits.optionChars)
    )
    if (new Set(texts).size !== texts.length)
      throw new BlockValidationError("options must be unique")
    const ordered = texts.map((text, index) => ({ id: optionId(index), text }))
    return {
      ...base,
      type,
      options: stableShuffle(ordered, `${base.id}:${base.question}`),
      correctOptionIds: ordered.map((option) => option.id),
    }
  }
  if (type === "matching") {
    if (
      !Array.isArray(data.pairs) ||
      data.pairs.length < limits.minPairs ||
      data.pairs.length > limits.maxPairs
    )
      throw new BlockValidationError(
        `pairs must contain ${limits.minPairs} to ${limits.maxPairs} [item, match] pairs`
      )
    const pairs = data.pairs.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2)
        throw new BlockValidationError(`pairs[${index}] must be [item, match]`)
      return [
        requiredText(pair[0], `pairs[${index}][0]`, limits.optionChars),
        requiredText(pair[1], `pairs[${index}][1]`, limits.optionChars),
      ] as const
    })
    const extras =
      data.extras === undefined || data.extras === null
        ? []
        : Array.isArray(data.extras)
          ? data.extras.map((extra, index) =>
              requiredText(extra, `extras[${index}]`, limits.optionChars)
            )
          : (() => {
              throw new BlockValidationError("extras must be an array of strings")
            })()
    if (extras.length > limits.maxMatchExtras)
      throw new BlockValidationError(`extras must contain at most ${limits.maxMatchExtras} entries`)
    const prompts = pairs.map((pair) => pair[0])
    const matches = [...pairs.map((pair) => pair[1]), ...extras]
    if (new Set(prompts).size !== prompts.length || new Set(matches).size !== matches.length)
      throw new BlockValidationError("matching items and matches must be unique")
    const options = matches.map((text, index) => ({ id: optionId(index), text }))
    return {
      ...base,
      type,
      prompts,
      options: stableShuffle(options, `${base.id}:${base.question}`),
      correctOptionIds: pairs.map((_, index) => optionId(index)),
    }
  }
  throw new BlockValidationError("unknown quiz type")
}

/**
 * Validates and normalizes a quiz body.
 * @param source Raw JSON fence body.
 * @returns The normalized quiz block.
 * @throws BlockValidationError describing the first invalid field.
 */
function parseQuiz(source: string): QuizBlock {
  const limits = INTERACTIVE_BLOCK_LIMITS
  const data = asObject(parseJson(source), "quiz")

  if (typeof data.id !== "string" || !limits.quizIdPattern.test(data.id))
    throw new BlockValidationError(
      "id must be 1–64 letters, digits, underscores, or hyphens"
    )
  const concept = requiredText(data.concept, "concept", limits.conceptChars)
  const question = requiredText(data.question, "question", limits.questionChars)
  const explanation = requiredText(
    data.explanation,
    "explanation",
    limits.explanationChars
  )
  const type = data.type
  if (
    type === "cloze" ||
    type === "ordering" ||
    type === "matching" ||
    type === "code-output"
  )
    return parseStructuredQuiz(data, {
      kind: "quiz",
      id: data.id,
      concept,
      question,
      explanation,
    })
  if (
    type !== "single-choice" &&
    type !== "multiple-answer" &&
    type !== "true-false"
  )
    throw new BlockValidationError(
      'type must be "single-choice", "multiple-answer", "true-false", "cloze", "ordering", "matching", or "code-output"'
    )

  const base = { kind: "quiz" as const, id: data.id, concept, question }

  // True or false questions ignore any supplied options and use fixed ids.
  if (type === "true-false") {
    if (typeof data.answer !== "boolean")
      throw new BlockValidationError(
        "answer must be true or false for a true-false question"
      )
    return {
      ...base,
      type,
      options: [
        { id: "true", text: "True" },
        { id: "false", text: "False" },
      ],
      correctOptionIds: [data.answer ? "true" : "false"],
      explanation,
    }
  }

  // Choice questions need a small set of distinct options.
  if (!Array.isArray(data.options))
    throw new BlockValidationError("options must be an array of strings")
  if (
    data.options.length < limits.minOptions ||
    data.options.length > limits.maxOptions
  )
    throw new BlockValidationError(
      `options must contain ${limits.minOptions} to ${limits.maxOptions} entries`
    )
  const texts = data.options.map((option, index) =>
    requiredText(option, `options[${index}]`, limits.optionChars)
  )
  if (new Set(texts).size !== texts.length)
    throw new BlockValidationError("options must be unique")
  const options = texts.map((text, index) => ({ id: optionId(index), text }))

  let indices: number[]
  if (type === "single-choice") {
    // A one-element array is a common model variation of a single index.
    const answer =
      Array.isArray(data.answer) && data.answer.length === 1
        ? data.answer[0]
        : data.answer
    indices = [optionIndex(answer, options.length)]
  } else {
    if (!Array.isArray(data.answer))
      throw new BlockValidationError(
        "answer must be an array of option indices for a multiple-answer question"
      )
    indices = data.answer.map((value) => optionIndex(value, options.length))
    if (new Set(indices).size !== indices.length)
      throw new BlockValidationError("answer indices must be unique")
    // At least two correct and at least one incorrect, otherwise it is not a real multiple-answer question.
    if (indices.length < 2 || indices.length >= options.length)
      throw new BlockValidationError(
        "a multiple-answer question needs at least 2 correct options and at least 1 incorrect option"
      )
    indices = [...indices].sort((left, right) => left - right)
  }

  return {
    ...base,
    type,
    options,
    correctOptionIds: indices.map(optionId),
    explanation,
  }
}

/**
 * Validates a worked example body.
 * @param source Raw JSON fence body.
 * @param title Optional title from the fence info string.
 * @returns The steps block.
 * @throws BlockValidationError describing the first invalid field.
 */
function parseSteps(source: string, title: string | undefined): StepsBlock {
  const limits = INTERACTIVE_BLOCK_LIMITS
  const data = asObject(parseJson(source), "steps")
  if (!Array.isArray(data.steps))
    throw new BlockValidationError("steps must be an array")
  if (data.steps.length < 1 || data.steps.length > limits.maxSteps)
    throw new BlockValidationError(
      `steps must contain 1 to ${limits.maxSteps} entries`
    )
  const steps = data.steps.map((value, index) => {
    const step = asObject(value, `steps[${index}]`)
    const stepTitle = optionalText(
      step.title,
      `steps[${index}].title`,
      limits.stepTitleChars
    )
    const body = requiredText(
      step.body,
      `steps[${index}].body`,
      limits.stepBodyChars
    )
    return stepTitle ? { title: stepTitle, body } : { body }
  })
  return title ? { kind: "steps", title, steps } : { kind: "steps", steps }
}

/**
 * Validates a visualisation body. The HTML itself is not sanitized; renderers must sandbox it.
 * @param source Raw HTML fence body.
 * @param title Optional title from the fence info string.
 * @returns The visualisation block with the HTML unchanged apart from surrounding whitespace.
 * @throws BlockValidationError when the HTML is empty or too long.
 */
function parseViz(source: string, title: string | undefined): VizBlock {
  const html = source.trim()
  if (!html) throw new BlockValidationError("viz HTML must not be empty")
  if (html.length > VIZ_HTML_MAX_CHARS)
    throw new BlockValidationError(
      `viz HTML must be at most ${VIZ_HTML_MAX_CHARS} characters`
    )
  return title ? { kind: "viz", title, html } : { kind: "viz", html }
}

/**
 * Validates a follow-up suggestion list.
 * @param source Raw JSON fence body.
 * @returns The follow-ups block.
 * @throws BlockValidationError describing the first invalid entry.
 */
function parseFollowups(source: string): FollowupsBlock {
  const limits = INTERACTIVE_BLOCK_LIMITS
  const data = parseJson(source)
  if (!Array.isArray(data))
    throw new BlockValidationError("followups must be a JSON array of strings")
  if (data.length < 1 || data.length > limits.maxFollowups)
    throw new BlockValidationError(
      `followups must contain 1 to ${limits.maxFollowups} entries`
    )
  return {
    kind: "followups",
    items: data.map((item, index) =>
      requiredText(item, `followups[${index}]`, limits.followupChars)
    ),
  }
}

/**
 * Parses and validates one fenced interactive block. Never throws.
 * @param infoString Full fence info string (e.g. "viz Recursion tree"); the first word is the language
 * and the remainder is an optional title used by `steps` and `viz`.
 * @param source Fence body.
 * @returns The normalized block, or an error describing why the fence is not a valid block.
 */
export function parseInteractiveBlock(
  infoString: string,
  source: string
): ParsedInteractiveBlock {
  const { language, title } = splitFenceInfo(infoString)
  try {
    switch (language) {
      case "quiz":
        return { ok: true, block: parseQuiz(source) }
      case "steps":
        return { ok: true, block: parseSteps(source, title) }
      case "viz":
        return { ok: true, block: parseViz(source, title) }
      case "followups":
        return { ok: true, block: parseFollowups(source) }
      default:
        return {
          ok: false,
          error: `"${language}" is not an interactive block language`,
        }
    }
  } catch (error) {
    return {
      ok: false,
      error: `Invalid ${language} block: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Reports whether a Marked code token's raw text ends with a closing fence. While a reply streams, an
 * unclosed fence is still being written, so renderers wait instead of drawing partial content.
 * @param raw The `raw` text of a fenced code token.
 * @returns True for a fenced block with a matching closing fence; false for unclosed or indented code.
 */
export function isClosedCodeFence(raw: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(raw)
  if (!opening) return false
  const lines = raw.replace(/\s+$/, "").split("\n")
  if (lines.length < 2) return false
  const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[lines.length - 1])
  return Boolean(
    closing &&
    closing[1][0] === opening[1][0] &&
    closing[1].length >= opening[1].length
  )
}

/**
 * Collects fenced code tokens in document order, including fences nested in lists and blockquotes.
 * @param tokens Marked block tokens.
 * @returns Every code token in reading order.
 */
function codeTokens(tokens: Token[]): Tokens.Code[] {
  return tokens.flatMap((token): Tokens.Code[] => {
    if (token.type === "code") return [token as Tokens.Code]
    if (token.type === "list")
      return (token as Tokens.List).items.flatMap((item) =>
        codeTokens(item.tokens)
      )
    return "tokens" in token && token.tokens ? codeTokens(token.tokens) : []
  })
}

/**
 * Finds every valid quiz block in a Markdown message, in order. Invalid quizzes are skipped and, when
 * ids repeat, only the first quiz with that id is kept, matching what the learner can answer.
 * @param markdown Complete Markdown message.
 * @returns Valid quiz blocks in document order.
 */
export function findQuizBlocks(markdown: string): QuizBlock[] {
  const quizzes: QuizBlock[] = []
  const seen = new Set<string>()
  for (const token of codeTokens(lexer(markdown, { gfm: true }))) {
    if (splitFenceInfo(token.lang ?? "").language !== "quiz") continue
    const parsed = parseInteractiveBlock(token.lang ?? "", token.text)
    if (!parsed.ok || parsed.block.kind !== "quiz") continue
    if (seen.has(parsed.block.id)) continue
    seen.add(parsed.block.id)
    quizzes.push(parsed.block)
  }
  return quizzes
}

/**
 * Returns the fields a quiz is saved with as a learning item (everything but
 * `kind` and `id`), matching `quizValidator` in `convex/quizFields.ts`.
 * @param block A validated quiz.
 * @returns A plain object safe to send to Convex.
 */
export function quizPayload(block: QuizBlock) {
  return {
    concept: block.concept,
    type: block.type,
    question: block.question,
    options: block.options,
    correctOptionIds: block.correctOptionIds,
    ...(block.prompts ? { prompts: block.prompts } : {}),
    ...(block.acceptedAnswers ? { acceptedAnswers: block.acceptedAnswers } : {}),
    explanation: block.explanation,
  }
}

/** The parts of a structured question needed to collect an answer, without its answer key. */
export type StructuredAnswerShape = {
  type: QuizType
  question: string
  options: readonly QuizOption[]
  prompts?: readonly string[]
}

/**
 * Shows a cloze prompt's numbered blanks as `____(1)`, which reads as a gap in
 * prose and in code alike and does not form Markdown emphasis.
 * @param question Cloze prompt with `{{n}}` blanks.
 * @returns The prompt for display.
 */
export function clozeDisplayText(question: string): string {
  return question.replace(/\{\{\s*(\d{1,2})\s*\}\}/g, "____($1)")
}

/**
 * Returns the empty answer a structured question starts from: the displayed
 * order for ordering, and one empty value per pair, blank, or output.
 * @param shape The question being answered.
 * @returns A fresh answer list.
 */
export function initialStructuredAnswer(shape: StructuredAnswerShape): string[] {
  switch (shape.type) {
    case "ordering":
      return shape.options.map((option) => option.id)
    case "matching":
      return (shape.prompts ?? []).map(() => "")
    case "cloze":
      return Array.from({ length: Math.max(1, countClozeBlanks(shape.question)) }, () => "")
    default:
      return [""]
  }
}

/**
 * Reports whether a structured answer can be checked: every pair matched,
 * at least one blank filled, or some output typed. Ordering is always ready.
 * @param type Question format.
 * @param value Current answer list.
 */
export function structuredAnswerReady(type: QuizType, value: readonly string[]): boolean {
  if (type === "ordering") return value.length > 1
  if (type === "matching") return value.length > 0 && value.every(Boolean)
  return value.some((entry) => entry.trim().length > 0)
}

/** Quiz formats answered by choosing options rather than typing or arranging. */
export function isChoiceQuiz(type: QuizType): type is "single-choice" | "multiple-answer" | "true-false" {
  return type === "single-choice" || type === "multiple-answer" || type === "true-false"
}

/**
 * Converts a structured quiz into the learning core's question shape, so the
 * browser grades it with the same rules as the server.
 * @param block A cloze, ordering, matching, or code-output quiz.
 * @returns The core question.
 */
export function structuredQuestion(block: QuizBlock): Question {
  const base = { id: block.id, conceptId: block.concept, prompt: block.question }
  switch (block.type) {
    case "cloze":
      return { ...base, type: "cloze", acceptedAnswers: block.acceptedAnswers ?? [] }
    case "code-output":
      return { ...base, type: "code-output", acceptedOutputs: block.acceptedAnswers?.[0] ?? [] }
    case "ordering":
      return { ...base, type: "ordering", options: block.options, correctOrder: block.correctOptionIds }
    case "matching":
      return {
        ...base,
        type: "matching",
        prompts: block.prompts ?? [],
        options: block.options,
        correctOptionIds: block.correctOptionIds,
      }
    default:
      throw new Error("Choice quizzes are graded by option set")
  }
}

/**
 * Grades a learner's answer against a quiz. A multiple-answer question is correct only when the
 * selection matches every correct option and no incorrect one; structured formats use the learning
 * core's rules (typed blanks and output are normalized, order and pairs must match exactly).
 * @param block Validated quiz block.
 * @param selectedOptionIds Option ids chosen by the learner, in any order, with duplicates ignored;
 * or, for structured formats, the typed or arranged answer list.
 * @returns True when the answer is correct.
 */
export function gradeQuizAnswer(
  block: QuizBlock,
  selectedOptionIds: readonly string[]
): boolean {
  if (!isChoiceQuiz(block.type))
    return evaluateAnswer(structuredQuestion(block), selectedOptionIds).isCorrect
  const selected = new Set(selectedOptionIds)
  return (
    selected.size === block.correctOptionIds.length &&
    block.correctOptionIds.every((id) => selected.has(id))
  )
}

/**
 * Summarizes a block as plain text for read-aloud and copying. Quiz answers and explanations are never
 * included so listening does not give away the answer.
 * @param block A validated interactive block.
 * @returns Plain text, or an empty string for follow-up suggestions.
 */
export function interactiveBlockSpeechText(block: InteractiveBlock): string {
  switch (block.kind) {
    case "quiz": {
      if (block.type === "ordering")
        return `Question: ${block.question} Put these in order: ${block.options.map((option) => option.text).join("; ")}.`
      if (block.type === "matching")
        return `Question: ${block.question} Match each of: ${(block.prompts ?? []).join("; ")}. With one of: ${block.options.map((option) => option.text).join("; ")}.`
      if (block.type === "cloze")
        return `Question: ${block.question.replace(/\{\{\s*(\d+)\s*\}\}/g, "blank $1")}`
      if (block.type === "code-output")
        return `Question: ${block.question} Type the output.`
      const options =
        block.type === "true-false"
          ? "True or false."
          : block.options
              .map(
                (option, index) =>
                  `${String.fromCharCode(65 + index)}. ${option.text}`
              )
              .join("; ") + "."
      const prompt =
        block.type === "multiple-answer" ? " Choose all that apply." : ""
      return `Question: ${block.question}${prompt} Options: ${options}`
    }
    case "steps": {
      const steps = block.steps.map(
        (step, index) =>
          `Step ${index + 1}${step.title ? `: ${step.title}` : ""}.\n${step.body}`
      )
      return [block.title, ...steps].filter(Boolean).join("\n\n")
    }
    case "viz":
      return block.title
        ? `[Interactive visualisation: ${block.title}]`
        : "[Interactive visualisation]"
    case "followups":
      return ""
  }
}

/** Theme values injected into a visualisation document so it matches the surrounding app. */
export type VizTheme = {
  dark: boolean
  background: string
  foreground: string
  muted: string
  mutedForeground: string
  border: string
  brand: string
  brandForeground: string
  fontFamily: string
}

/** Message type posted by the visualisation document with its content height in CSS pixels. */
export const VIZ_HEIGHT_MESSAGE = "blitz-viz-height"
/** Message type posted by the parent with an updated `VizTheme` after a theme change. */
export const VIZ_THEME_MESSAGE = "blitz-viz-theme"

/** Content Security Policy applied to every visualisation: inline code only, no network access. */
export const VIZ_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:"

/** Fallback palette used when a computed theme value is missing or unsafe to embed in CSS. */
const fallbackVizTheme: Omit<VizTheme, "dark"> = {
  background: "#fafafa",
  foreground: "#111111",
  muted: "#f1f1f1",
  mutedForeground: "#666666",
  border: "#dedede",
  brand: "#aa3822",
  brandForeground: "#ffffff",
  fontFamily: "system-ui, sans-serif",
}

/**
 * Restricts a theme value to characters that cannot close the style element or a CSS declaration.
 * @param value Computed style value from the parent page.
 * @param fallback Value used when the input is empty or contains other characters.
 * @returns A value safe to embed in a CSS custom property.
 */
function safeCssValue(value: string, fallback: string): string {
  const trimmed = value.trim()
  return trimmed && /^[#\w\s(),.%/"'+-]+$/.test(trimmed) ? trimmed : fallback
}

/**
 * Normalizes a theme to safe CSS custom property declarations.
 * @param theme Theme values read from the parent page.
 * @returns CSS declarations for `:root`, including `color-scheme`.
 */
export function vizThemeDeclarations(theme: VizTheme): string {
  const values: Array<[string, keyof typeof fallbackVizTheme]> = [
    ["--background", "background"],
    ["--foreground", "foreground"],
    ["--muted", "muted"],
    ["--muted-foreground", "mutedForeground"],
    ["--border", "border"],
    ["--brand", "brand"],
    ["--brand-foreground", "brandForeground"],
    ["--font-sans", "fontFamily"],
  ]
  return [
    `color-scheme: ${theme.dark ? "dark" : "light"};`,
    ...values.map(
      ([property, key]) =>
        `${property}: ${safeCssValue(theme[key], fallbackVizTheme[key])};`
    ),
  ].join(" ")
}

/**
 * Script injected before the model HTML. It reports content height to the parent whenever layout
 * changes and applies theme updates posted by the parent, so theme switches keep interactive state.
 */
const vizBridgeScript = `(function () {
  var last = -1;
  function measure() {
    var body = document.body;
    if (!body) return;
    var root = document.getElementById("blitz-viz-root") || body;
    var style = getComputedStyle(body);
    var height = Math.ceil(
      root.getBoundingClientRect().bottom + window.scrollY +
      parseFloat(style.paddingBottom || "0") + parseFloat(style.marginBottom || "0")
    );
    if (height !== last) {
      last = height;
      parent.postMessage({ type: "${VIZ_HEIGHT_MESSAGE}", height: height }, "*");
    }
  }
  function start() {
    measure();
    if (typeof ResizeObserver === "function") {
      var observer = new ResizeObserver(measure);
      observer.observe(document.body);
      var root = document.getElementById("blitz-viz-root");
      if (root) observer.observe(root);
    }
    window.addEventListener("load", measure);
    window.addEventListener("resize", measure);
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.type !== "${VIZ_THEME_MESSAGE}" || typeof data.css !== "string") return;
    var style = document.getElementById("blitz-viz-theme");
    if (style) style.textContent = ":root { " + data.css + " }";
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();`

/** Base styles so visualisations inherit the app's colours, type, and reduced-motion preference. */
const vizBaseStyles = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: var(--background); color: var(--foreground); }
body { padding: 12px; font-family: var(--font-sans); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
#blitz-viz-root { display: flow-root; }
canvas, img, video { max-width: 100%; height: auto; }
svg { max-width: 100%; }
button, input, select, textarea { font: inherit; color: inherit; }
button { min-height: 36px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--muted); cursor: pointer; }
button:hover { border-color: var(--brand); }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
input[type="range"] { accent-color: var(--brand); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}`

/**
 * Builds the `srcdoc` for a visualisation iframe. The CSP meta tag comes first so it governs all model
 * content; links target a blocked popup context; meta refresh tags are removed so the frame cannot
 * redirect itself on load. The returned document must only be used with `sandbox="allow-scripts"`.
 * @param html Model-authored visualisation HTML.
 * @param theme Current app theme used for the initial styles.
 * @returns A complete HTML document string.
 */
export function buildVizDocument(html: string, theme: VizTheme): string {
  const content = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi,
    ""
  )
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    `<meta http-equiv="Content-Security-Policy" content="${VIZ_CONTENT_SECURITY_POLICY}">`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<base target="_blank">',
    `<style id="blitz-viz-theme">:root { ${vizThemeDeclarations(theme)} }</style>`,
    `<style>${vizBaseStyles}</style>`,
    `<script>${vizBridgeScript}</script>`,
    '</head><body><div id="blitz-viz-root">',
    content,
    "</div></body></html>",
  ].join("\n")
}

/**
 * Model instructions documenting this protocol. Kept concise because it is sent with every tutoring
 * request; examples are short and valid so the model copies the exact shapes.
 */
export const INTERACTIVE_BLOCKS_PROMPT = `## Interactive blocks

You can embed interactive elements as fenced code blocks. The first word after the opening fence is the block type; for steps and viz, any words after it are a title. Bodies must match the formats below exactly. A malformed block is shown to the learner as raw code, so keep JSON valid (double quotes, no comments, no trailing commas). Never mention these block names or formats to the learner.

### quiz: check understanding
Use after a key idea, roughly one per section. Ask about the idea, not trivia. One question per block.
\`\`\`quiz
{"id":"q1","concept":"Karatsuba multiplication","type":"single-choice","question":"How many recursive multiplications does Karatsuba use per step?","options":["2","3","4"],"answer":1,"explanation":"It computes three products and recovers the middle term by subtraction."}
\`\`\`
- id: unique within the reply, letters, digits, _ or - (max 64). concept: the idea being tested (max 120 chars).
- type "single-choice": 2–6 distinct options, answer is the 0-based index of the correct option.
- type "multiple-answer": 2–6 distinct options, answer is an array of 0-based indices with at least 2 correct and at least 1 incorrect.
- type "true-false": omit options, answer is true or false.
- question max 1000 chars, explanation max 2000 chars (Markdown allowed). Do not reveal the answer outside the block.
Other types, for recall that choices would give away:
- "cloze": mark 1–6 blanks in the question as {{1}}, {{2}}…; answer is one list of accepted answers per blank, e.g. "answer":[["O(log n)","log n"],["root"]]. Accept common spellings; matching ignores case and spacing.
- "ordering": options are 3–8 steps or items listed in the correct order (they are shuffled for the learner); no answer field.
- "matching": "pairs":[["term","its match"],…] with 3–6 pairs, optional "extras":["unused match"] (max 2); no options or answer.
- "code-output": the question includes a fenced code block; answer is the exact output, or a list of accepted outputs. Keep programs short and deterministic.

### steps: worked example revealed one step at a time
Use for worked problems, derivations, proofs, and code traces. 1–12 steps; each body is Markdown (max 4000 chars), title optional.
\`\`\`steps Solving 2x + 3 = 11
{"steps":[{"title":"Isolate the term","body":"Subtract 3: $2x = 8$."},{"title":"Solve","body":"Divide by 2: $x = 4$."}]}
\`\`\`

### viz: interactive visualisation
Use only when interaction genuinely aids understanding (for example sliders, step controls, or toggles that reveal how something changes). The body is raw, self-contained HTML with inline <style> and <script> (SVG or canvas welcome), under about 200 lines. No external resources: no CDN scripts, fonts, images, or network requests; they are blocked. It runs in an isolated frame that sizes to its content. Use the CSS variables --background, --foreground, --muted, --muted-foreground, --border, --brand, and --font-sans so it matches light and dark themes.
\`\`\`viz Growth of n squared
<label>n = <input id="n" type="range" min="1" max="20" value="5"></label>
<p id="out"></p>
<script>const n=document.getElementById("n"),o=document.getElementById("out");const u=()=>o.textContent="n² = "+n.value*n.value;n.oninput=u;u();</script>
\`\`\`

### followups: suggested next questions
Optionally end a reply with up to 3 short follow-up questions the learner might ask next, each under 120 characters, written as the learner would ask them. Place it last and use at most one per reply.
\`\`\`followups
["Why does this make it faster?","Show another example"]
\`\`\``
