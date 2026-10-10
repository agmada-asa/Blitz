"use client"

/**
 * Renders suggested follow-up questions from a ```followups Markdown block as small buttons that send
 * the suggestion as the learner's next message. Suggestions are hidden when the surrounding chat
 * provides no `onFollowUp` handler, and disabled while the reply is still streaming.
 */
import type { FollowupsBlock } from "@/lib/interactive-blocks"
import { Button } from "@/components/ui/button"
import { useInteractiveBlocks } from "@/components/ui/interactive-blocks/context"

/**
 * Renders the suggestion buttons for one follow-ups block.
 * @param block Validated follow-ups block.
 * @param streaming Whether the containing reply is still streaming.
 * @returns A group of suggestion buttons, or null without a follow-up handler.
 */
export function FollowupsBlockView({
  block,
  streaming,
}: {
  block: FollowupsBlock
  streaming: boolean
}) {
  const { onFollowUp } = useInteractiveBlocks()
  if (!onFollowUp) return null
  return (
    <div
      role="group"
      aria-label="Suggested questions"
      className="interactive-block flex flex-wrap gap-2"
    >
      {block.items.map((item, index) => (
        <Button
          key={index}
          type="button"
          variant="outline"
          size="sm"
          disabled={streaming}
          onClick={() => onFollowUp(item)}
          className="h-auto min-h-11 max-w-full px-3 py-2 text-left text-sm font-normal whitespace-normal text-muted-foreground hover:text-foreground sm:min-h-9"
        >
          {item}
        </Button>
      ))}
    </div>
  )
}
