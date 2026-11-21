/**
 * Declares the queue the packaged desktop app's entry point keeps for
 * `blitz://` links that arrive before `electron/main.mjs` loads
 * (see `scripts/install-desktop.mjs` and `electron/open-links.mjs`).
 */

declare global {
  /** Links waiting for the app code, and a function that stops queueing more. */
  var blitzLinkQueue: { links: string[]; stop: () => void } | undefined
}

export {}
