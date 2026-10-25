/**
 * Shows why a reply stopped short: a tool its access setting blocked, a
 * refusal, or a safety check. Used above chat and Teach replies, so a short
 * answer explains itself instead of looking half-finished.
 */

import { turnNoticeCopy, type TurnNotice } from "@/lib/turn-notices"

/**
 * Renders a reply's notices, or nothing when it has none.
 *
 * @param notices - Saved on the reply, already filtered and bounded.
 * @param context - `teach` or `chat`, which changes how a blocked tool is explained.
 */
export function TurnNotices({
  notices,
  context,
}: {
  notices: readonly TurnNotice[]
  context: "teach" | "chat"
}) {
  if (!notices.length) return null
  return (
    <ul className="mb-3 space-y-2" aria-label="About this reply">
      {notices.map((notice, index) => {
        const copy = turnNoticeCopy(notice, context)
        return (
          <li
            key={`${notice.kind}-${index}`}
            className="rounded-xl border border-border bg-muted/40 px-3.5 py-2.5 text-sm"
          >
            <p className="font-medium text-foreground">{copy.title}</p>
            <p className="mt-0.5 text-muted-foreground">{copy.detail}</p>
          </li>
        )
      })}
    </ul>
  )
}
