/**
 * Decides which runtime notices reach the learner and how they read.
 *
 * Codex and Claude Code report many notices while a turn runs: warnings,
 * configuration and deprecation messages, refusals, denied tools, and safety
 * checks. Only the three that explain why a reply stopped short are shown,
 * beside the reply they belong to; the rest go to the server log so the chat
 * never fills with runtime noise. This module is pure so the server, Convex,
 * and the chat and Teach screens agree on the same rules and wording.
 */

/** The notice kinds a learner sees. Every other kind stays in the server log. */
export const SHOWN_NOTICE_KINDS = [
  "refusal",
  "permission-denied",
  "moderation",
] as const

/** A notice kind shown beside a reply. */
export type TurnNoticeKind = (typeof SHOWN_NOTICE_KINDS)[number]

/** One notice saved on an assistant message. */
export type TurnNotice = {
  kind: TurnNoticeKind
  /** The runtime's own sentence, bounded; shown as supporting detail. */
  message: string
  /** Why the runtime decided this, when it said (a rule name, a reason). */
  details?: string
}

/** Most notices kept on one reply; later ones are dropped. */
export const MAX_TURN_NOTICES = 5

/** Longest runtime sentence kept for a notice. */
const MAX_NOTICE_MESSAGE = 300

/** Longest runtime reason kept for a notice. */
const MAX_NOTICE_DETAILS = 200

/** Trims and bounds runtime text, collapsing whitespace. */
function bounded(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined
  const text = value.replace(/\s+/g, " ").trim()
  return text ? text.slice(0, maximum) : undefined
}

/**
 * Returns the notice to show for one runtime notice, or undefined when its
 * kind belongs in the server log.
 *
 * @param kind - The runtime's notice kind (`refusal`, `warning`…).
 * @param message - The runtime's sentence.
 * @param details - The runtime's reason, when it gave one.
 */
export function shownTurnNotice(
  kind: string,
  message: unknown,
  details?: unknown
): TurnNotice | undefined {
  if (!(SHOWN_NOTICE_KINDS as readonly string[]).includes(kind)) return undefined
  const text = bounded(message, MAX_NOTICE_MESSAGE) ?? ""
  const reason = bounded(details, MAX_NOTICE_DETAILS)
  return {
    kind: kind as TurnNoticeKind,
    message: text,
    ...(reason && reason !== text ? { details: reason } : {}),
  }
}

/**
 * Adds a notice to a reply's list, skipping exact repeats and keeping the
 * list within `MAX_TURN_NOTICES`.
 *
 * @returns The new list, or the same list when nothing was added.
 */
export function addTurnNotice(
  notices: readonly TurnNotice[],
  notice: TurnNotice
): readonly TurnNotice[] {
  if (notices.length >= MAX_TURN_NOTICES) return notices
  if (
    notices.some(
      (existing) =>
        existing.kind === notice.kind && existing.message === notice.message
    )
  )
    return notices
  return [...notices, notice]
}

/**
 * The words shown for a notice: a plain headline and one line of detail.
 *
 * @param notice - The saved notice.
 * @param context - `teach` for a Teach session, which never uses tools that
 *   change files or reach the web; `chat` for an ordinary chat, whose access
 *   setting the learner can change.
 */
export function turnNoticeCopy(
  notice: TurnNotice,
  context: "teach" | "chat"
): { title: string; detail: string } {
  const runtime = notice.message
  switch (notice.kind) {
    case "permission-denied":
      return {
        title: "A tool was blocked, so this reply may be incomplete.",
        detail:
          context === "teach"
            ? `${runtime ? `${runtime} ` : ""}Teach only reads your material, so it can't edit files or use the web.`
            : `${runtime ? `${runtime} ` : ""}This chat's access setting doesn't allow it. Change it in Options to let the tool run.`,
      }
    case "refusal":
      return {
        title: "The model declined part of this request.",
        detail: runtime || "Try rephrasing the request.",
      }
    case "moderation":
      // Runtime moderation text names internal checks, so it stays in the log.
      return {
        title: "A safety check limited this reply.",
        detail: "Some of the reply may have been held back. Try rephrasing the request.",
      }
  }
}
