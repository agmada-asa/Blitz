/** Identifies whether a chat reply belongs to the chat interface currently open. */

/** Chat notification kinds that can be matched against the current URL. */
export type ChatNotificationKind = "card-reply" | "workspace-reply"

/**
 * Checks whether a chat notification targets the conversation visible in the UI.
 * Returns false for non-chat routes or malformed URLs so callers can announce
 * those notifications normally.
 */
export function isNotificationInCurrentChat(
  kind: ChatNotificationKind,
  notificationHref: string,
  currentPathname: string,
  currentSearch: string
): boolean {
  if (currentPathname !== "/chat") return false

  try {
    const notificationUrl = new URL(notificationHref, "http://blitz.local")
    if (notificationUrl.pathname !== "/chat") return false

    const currentParams = new URLSearchParams(currentSearch)
    const notificationParams = notificationUrl.searchParams
    if (kind === "workspace-reply") {
      const currentChatId = currentParams.get("chatId")
      const notificationChatId = notificationParams.get("chatId")
      return Boolean(
        currentChatId &&
          notificationChatId &&
          currentChatId === notificationChatId
      )
    }

    const currentProjectId = currentParams.get("projectId")
    const currentItemId = currentParams.get("itemId")
    return Boolean(
      currentProjectId &&
        currentItemId &&
        currentProjectId === notificationParams.get("projectId") &&
        currentItemId === notificationParams.get("itemId")
    )
  } catch {
    return false
  }
}
