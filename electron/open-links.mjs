/**
 * Turns `blitz://` links into pages of the local app, so a link to Blitz can
 * open in the desktop window instead of a browser.
 *
 * The packaged app registers the `blitz` scheme with macOS (see
 * `scripts/package-desktop.mjs`). A link names a page by its path:
 * `blitz://projects/abc/learn/xyz` and `blitz:///projects/abc/learn/xyz` both
 * open `/projects/abc/learn/xyz`, and `blitz://` alone opens the Library.
 * A browser page hands itself to the app the same way (`lib/client/desktop-links.ts`).
 *
 * This module has no Electron imports so its parsing can be tested on its own.
 */

/** The URL scheme the desktop app answers. */
export const LINK_SCHEME = "blitz"

/**
 * Returns the app path a `blitz://` link points to, with its query and hash.
 * @param {string} link The URL macOS handed to the app.
 * @returns {string | undefined} A path starting with one `/`, or undefined
 *   when the link is not a well-formed `blitz://` URL.
 */
export function linkPath(link) {
  let url
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  if (url.protocol !== `${LINK_SCHEME}:`) return undefined
  // In `blitz://projects/abc` the first segment parses as the host.
  const path = `${url.host}${url.pathname}`.replace(/^\/+/, "")
  return `/${path}${url.search}${url.hash}`
}

/**
 * Resolves a `blitz://` link against the app the window shows.
 * @param {string} link The URL macOS handed to the app.
 * @param {string} origin The app's origin, such as `http://127.0.0.1:3007`.
 * @returns {string | undefined} The page to load, or undefined when the link
 *   is malformed or would leave the app's origin.
 */
export function linkTarget(link, origin) {
  const path = linkPath(link)
  if (path === undefined) return undefined
  const target = new URL(path, origin)
  return target.origin === new URL(origin).origin ? target.href : undefined
}

/**
 * Takes the links the bundle's entry point queued before this module loaded.
 *
 * macOS delivers the link that launched the app before Electron is ready, and
 * the entry point loads this code with a dynamic import that can finish after
 * that. The entry point therefore queues early links on
 * `globalThis.blitzLinkQueue`; this stops the queue and returns what it held.
 * @returns {string[]} Queued links, oldest first; empty without a queue.
 */
export function takeQueuedLinks() {
  const queue = globalThis.blitzLinkQueue
  if (!queue) return []
  queue.stop()
  globalThis.blitzLinkQueue = undefined
  return queue.links
}
