"use client"

/**
 * Shares chat-level handlers and state with interactive Markdown blocks.
 *
 * The chat or Teach page wraps each assistant message in `InteractiveBlocksProvider` so quizzes can be
 * scored and recorded by the server, previously answered quizzes reload in their answered state, and
 * follow-up suggestions can send a new message. Blocks rendered without a provider still work: quizzes
 * grade locally and follow-up suggestions stay hidden.
 */
import { createContext, useContext, type ReactNode } from "react"
import type { QuizBlock } from "@/lib/interactive-blocks"

/** Handlers and state for the interactive blocks inside one message. */
export type InteractiveBlocksContextValue = {
  /** True while the message containing these blocks is still streaming. */
  streaming?: boolean
  /** Server-scored answer. Return null to fall back to local scoring. Throwing shows a retryable error. */
  onQuizAnswer?: (
    block: QuizBlock,
    selectedOptionIds: string[]
  ) => Promise<{ correct: boolean } | null>
  /** Previously recorded answers keyed by quiz id, so reloads show answered state. */
  answeredQuizzes?: Record<
    string,
    { selectedOptionIds: string[]; correct: boolean }
  >
  /** Sends a suggested follow-up as the learner's next message; suggestions are hidden without it. */
  onFollowUp?: (text: string) => void
  /** Lets quizzes be saved to a unit's question bank; the action is hidden without it. */
  quizSaving?: QuizSaving
}

/** Where a message's quizzes can be saved, and which already are. */
export type QuizSaving = {
  /** Module the units belong to, for the link to its Practice page. */
  projectId: string
  /** Units in the module, in order. */
  units: Array<{ id: string; title: string }>
  /** Unit offered first. */
  defaultUnitId: string
  /** Quizzes in this message already saved, keyed by quiz id. */
  saved: Record<string, { unitId: string; unitTitle: string }>
  /** Saves quizzes to a unit. Throwing shows a retryable error. */
  onSave: (quizIds: string[], unitId: string) => Promise<void>
}

/**
 * Renders Markdown nested inside an interactive block. Nested Markdown never renders further
 * interactive blocks, so a quiz inside a step body appears as code instead of recursing.
 * @param text Markdown source.
 * @param options `inline` renders a single paragraph's inline content only, for use inside buttons,
 * labels, and legends where block elements are invalid.
 */
export type MarkdownRenderer = (
  text: string,
  options?: { inline?: boolean }
) => ReactNode

/** Default value used when no provider is present: local grading and no follow-up handler. */
const InteractiveBlocksContext = createContext<InteractiveBlocksContextValue>(
  {}
)

/**
 * Provides interactive block handlers to every `Markdown` rendered inside it.
 * @param value Handlers and state for the message; keep handler identities stable to avoid re-renders.
 * @param children Message content.
 * @returns The context provider.
 */
export function InteractiveBlocksProvider({
  value,
  children,
}: {
  value: InteractiveBlocksContextValue
  children: ReactNode
}) {
  return (
    <InteractiveBlocksContext.Provider value={value}>
      {children}
    </InteractiveBlocksContext.Provider>
  )
}

/**
 * Reads the nearest interactive block handlers.
 * @returns The provider value, or an empty object when no provider is present.
 */
export function useInteractiveBlocks(): InteractiveBlocksContextValue {
  return useContext(InteractiveBlocksContext)
}
