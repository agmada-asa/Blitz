/**
 * Watches the attributes on `<html>` that change the app palette (light or dark mode and the accent),
 * so components that copy theme colours into content outside the CSS cascade can redraw it.
 */

/**
 * Subscribes to theme and accent changes, which next-themes and settings apply as attributes on `<html>`.
 * Suitable as the `subscribe` argument of `useSyncExternalStore`.
 * @param onChange Called when a theme-relevant attribute changes.
 * @returns A function that stops observing.
 */
export function subscribeToThemeAttributes(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-accent", "data-theme"],
  })
  return () => observer.disconnect()
}
