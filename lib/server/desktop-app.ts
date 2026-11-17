/**
 * Finds out whether this Mac has a Blitz desktop app that opens `blitz://`
 * links, so browser pages only offer to hand over to an app that can take them.
 *
 * The server runs on the same Mac as the app, so it can look at the installed
 * bundles directly. A copy built before links were supported has no `blitz`
 * scheme in its Info.plist and doesn't count.
 */

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Where `npm run desktop:install` puts the app, then the system-wide folder. */
export function desktopAppCandidates(home = homedir()): string[] {
  return [
    join(home, "Applications", "Blitz.app"),
    join("/Applications", "Blitz.app"),
  ]
}

/**
 * Returns whether an Info.plist declares the `blitz` URL scheme.
 * @param plist The XML text of a bundle's `Contents/Info.plist`.
 */
export function declaresLinkScheme(plist: string): boolean {
  const urlTypes = plist.match(
    /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g
  )
  return Boolean(urlTypes?.some((types) => /<string>blitz<\/string>/.test(types)))
}

/**
 * Returns whether an installed Blitz app on this Mac answers `blitz://` links.
 * Always false off macOS.
 * @param candidates Bundle paths to check, for tests.
 */
export async function desktopAppOpensLinks(
  candidates = desktopAppCandidates()
): Promise<boolean> {
  if (process.platform !== "darwin") return false
  for (const bundle of candidates) {
    const plist = await readFile(
      join(bundle, "Contents", "Info.plist"),
      "utf8"
    ).catch(() => "")
    if (declaresLinkScheme(plist)) return true
  }
  return false
}
