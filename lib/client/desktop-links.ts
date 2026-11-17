/**
 * Decides when a Blitz page opened in a Mac browser hands itself to the
 * desktop app, and builds the `blitz://` link that does it.
 *
 * The desktop app answers `blitz://<path>` (`electron/open-links.mjs`). A link
 * to Blitz that lands in a browser on the Mac that runs Blitz, for example one
 * an agent sent, reopens there when the app is installed and the learner has
 * not chosen to keep links in the browser (Settings › Desktop app). Phones,
 * tablets, other Macs, automated browsers, reloads and pages reached from
 * another Blitz page stay put.
 */

/** Where links to Blitz open in a Mac browser. */
export type LinkPreference = "app" | "browser"

/** localStorage key for the learner's `LinkPreference`, per browser and address. */
export const LINK_PREFERENCE_KEY = "blitz-open-links-in"

/** The part of `window.location` a desktop link carries. */
type PageLocation = Pick<Location, "pathname" | "search" | "hash">

/**
 * Builds the `blitz://` link for a page: `/projects/abc` becomes `blitz://projects/abc`.
 * @param location The page's path, query and hash.
 * @returns A link the desktop app opens at the same page.
 */
export function desktopLink({ pathname, search, hash }: PageLocation): string {
  return `blitz://${pathname.replace(/^\/+/, "")}${search}${hash}`
}

/**
 * Returns whether a browser is a Mac's desktop browser. iPads also report
 * "Macintosh" but have a touch screen.
 * @param userAgent `navigator.userAgent`.
 * @param maxTouchPoints `navigator.maxTouchPoints`.
 */
export function isMacBrowser(userAgent: string, maxTouchPoints: number): boolean {
  return /Macintosh/.test(userAgent) && maxTouchPoints <= 1
}

/** What `shouldHandOff` needs to know about the page load. */
type PageLoad = {
  /** True inside the desktop app's own window. */
  inDesktopApp: boolean
  /** True in a Mac desktop browser (`isMacBrowser`). */
  macBrowser: boolean
  /**
   * `navigator.webdriver`: true in a browser an agent or test drives, which
   * should test the page it opened rather than move the real app to it.
   */
  automated: boolean
  /** The learner's saved choice; missing means the default, the app. */
  preference: LinkPreference | null
  /** `PerformanceNavigationTiming.type`, such as `navigate` or `reload`. */
  navigationType: string | undefined
  /** `document.referrer`, empty when the link came from outside a browser. */
  referrer: string
  /** The page's own origin. */
  origin: string
}

/**
 * Returns whether this page load should reopen in the desktop app: a fresh
 * arrival from a link, in a Mac browser a person uses, with links set to open
 * in the app. Reloads, back and forward, and pages reached from Blitz itself
 * stay in the browser so a learner who chose the browser isn't pulled away
 * again.
 */
export function shouldHandOff(load: PageLoad): boolean {
  if (load.inDesktopApp || !load.macBrowser || load.automated) return false
  if (load.preference === "browser") return false
  if (load.navigationType && load.navigationType !== "navigate") return false
  return !load.referrer || !load.referrer.startsWith(`${load.origin}/`)
}

/**
 * Asks the browser to open a `blitz://` link from a hidden frame. Navigating
 * the page itself would make WebKit cancel the page's own requests, leaving
 * the browser tab half loaded for a learner who stays in it.
 * @param link The `blitz://` link to open.
 */
export function openInDesktopApp(link: string): void {
  const frame = document.createElement("iframe")
  frame.hidden = true
  frame.src = link
  document.body.append(frame)
  // The browser has handed the link on (or asked) well before this.
  window.setTimeout(() => frame.remove(), 5_000)
}

/**
 * Reads the saved link preference, or null when none is saved or storage is blocked.
 */
export function readLinkPreference(): LinkPreference | null {
  try {
    const saved = window.localStorage.getItem(LINK_PREFERENCE_KEY)
    return saved === "app" || saved === "browser" ? saved : null
  } catch {
    return null
  }
}

/**
 * Saves the link preference for this browser and address.
 * @param preference Where links should open from now on.
 */
export function saveLinkPreference(preference: LinkPreference): void {
  try {
    window.localStorage.setItem(LINK_PREFERENCE_KEY, preference)
  } catch {
    // Private windows may refuse storage; the choice then lasts for this page only.
  }
}

/**
 * Asks the server whether this Mac has a Blitz app that answers `blitz://`
 * links. Resolves false when the server can't tell.
 */
export async function desktopAppAnswersLinks(): Promise<boolean> {
  try {
    const response = await fetch("/api/desktop", { cache: "no-store" })
    if (!response.ok) return false
    const body: unknown = await response.json()
    return (
      typeof body === "object" &&
      body !== null &&
      "opensLinks" in body &&
      body.opensLinks === true
    )
  } catch {
    return false
  }
}
