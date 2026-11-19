/** Identifies whether a chat reply belongs to the chat interface currently open. */

/**
 * Checks whether a chat reply notification targets the chat visible in the UI.
 * Returns false for non-chat routes or malformed URLs so callers can announce
 * those notifications normally.
 */
export function isNotificationInCurrentChat(
  notificationHref: string,
  currentPathname: string,
  currentSearch: string
): boolean {
  if (currentPathname !== "/chat") return false

  try {
    const notificationUrl = new URL(notificationHref, "http://blitz.local")
    if (notificationUrl.pathname !== "/chat") return false

    const currentChatId = new URLSearchParams(currentSearch).get("chatId")
    const notificationChatId = notificationUrl.searchParams.get("chatId")
    return Boolean(
      currentChatId && notificationChatId && currentChatId === notificationChatId
    )
  } catch {
    return false
  }
}
