/**
 * Guards Relearn requests so only Blitz's own Practice screens can send a
 * message to the tutor through a link. The link arms the exact message in
 * this tab's session storage; the Teach screen sends `?ask=` only when it
 * matches, so a crafted link cannot start a tutor turn on its own.
 */

/** Session storage key holding the armed Relearn message. */
const STORAGE_KEY = "blitz-relearn"

/** Records that the learner chose Relearn for this exact message. */
export function armRelearn(message: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, message)
  } catch {
    // Storage can be unavailable; the request then simply is not sent.
  }
}

/**
 * Returns whether `message` was armed by a Relearn action in this tab, and
 * clears it so a reload cannot send it twice.
 */
export function consumeRelearn(message: string): boolean {
  try {
    const armed = window.sessionStorage.getItem(STORAGE_KEY)
    window.sessionStorage.removeItem(STORAGE_KEY)
    return armed === message
  } catch {
    return false
  }
}
