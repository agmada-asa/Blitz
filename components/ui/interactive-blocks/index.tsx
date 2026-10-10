"use client"

/**
 * Entry point for interactive Markdown block renderers.
 *
 * `Markdown` parses ```quiz, ```steps, ```viz, and ```followups fences with `lib/interactive-blocks.ts`
 * and renders them here. Chat surfaces import `InteractiveBlocksProvider` from this module to supply
 * quiz scoring, recorded answers, streaming state, and follow-up handling.
 */
import type { ReactNode } from "react"
import type {
  InteractiveBlock,
  InteractiveBlockLanguage,
} from "@/lib/interactive-blocks"
import { Skeleton } from "@/components/ui/skeleton"
import type { MarkdownRenderer } from "@/components/ui/interactive-blocks/context"
import { FollowupsBlockView } from "@/components/ui/interactive-blocks/followups-block"
import { QuizBlockView } from "@/components/ui/interactive-blocks/quiz-block"
import { StepsBlockView } from "@/components/ui/interactive-blocks/steps-block"
import { VizBlockView } from "@/components/ui/interactive-blocks/viz-block"

export {
  InteractiveBlocksProvider,
  useInteractiveBlocks,
  type InteractiveBlocksContextValue,
  type MarkdownRenderer,
} from "@/components/ui/interactive-blocks/context"

/** Status text shown while a block is still streaming or not yet valid. */
const placeholderLabels: Record<
  Exclude<InteractiveBlockLanguage, "followups">,
  string
> = {
  quiz: "Preparing question…",
  steps: "Preparing worked example…",
  viz: "Preparing visualisation…",
}

/**
 * Shows a compact placeholder while an interactive block is still being written.
 * @param language Language of the unfinished block.
 * @returns A labeled skeleton, or null for follow-ups, which appear only once complete.
 */
export function InteractiveBlockPlaceholder({
  language,
}: {
  language: InteractiveBlockLanguage
}) {
  if (language === "followups") return null
  return (
    <div
      className="interactive-block space-y-3 rounded-xl border border-border p-4"
      role="status"
    >
      <p className="text-sm text-muted-foreground">
        {placeholderLabels[language]}
      </p>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  )
}

/**
 * Renders a validated interactive block with the view for its kind.
 * @param block Parsed block.
 * @param streaming Whether the containing reply is still streaming.
 * @param renderMarkdown Renders nested Markdown without further interactive blocks.
 * @param source Raw source view used by visualisations, normally a highlighted code block.
 * @returns The block view.
 */
export function InteractiveBlockView({
  block,
  streaming,
  renderMarkdown,
  source,
}: {
  block: InteractiveBlock
  streaming: boolean
  renderMarkdown: MarkdownRenderer
  source: ReactNode
}) {
  switch (block.kind) {
    case "quiz":
      return <QuizBlockView block={block} renderMarkdown={renderMarkdown} />
    case "steps":
      return <StepsBlockView block={block} renderMarkdown={renderMarkdown} />
    case "viz":
      return <VizBlockView block={block}>{source}</VizBlockView>
    case "followups":
      return <FollowupsBlockView block={block} streaming={streaming} />
  }
}
