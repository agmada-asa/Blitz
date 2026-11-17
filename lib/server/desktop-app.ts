/**
 * Finds out whether this Mac has a Blitz desktop app that opens `blitz://`
 * links, so browser pages only offer to hand over to an app that can take them.
 *
 * The server runs on the same Mac as the app, so it can look at the installed
 * bundles directly. A copy built before links were supported has no `blitz`
 * scheme in its Info.plist and doesn't count. That answer only holds for a
 * browser on this Mac: another Mac on the network or tailnet reaches the same
 * server, but a `blitz://` link there would open its own copy of Blitz or
 * nothing, so `isThisMachine` limits the answer to requests from here.
 */

import { readFile } from "node:fs/promises"
import { homedir, networkInterfaces } from "node:os"
import { join } from "node:path"

/**
 * Returns whether a request came from this machine, through loopback or one
 * of its own network addresses (such as its LAN or Tailscale address).
 * @param forwardedFor The `x-forwarded-for` header. Next sets it to the
 *   socket's address when it is missing, and a proxy such as `tailscale serve`
 *   appends the peer it saw, so the last entry is the nearest real client. A
 *   browser can spoof it, but that only changes what that browser is told.
 * @param interfaces This machine's addresses, for tests.
 * @returns False when the header is missing or names another machine.
 */
export function isThisMachine(
  forwardedFor: string | null,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()
): boolean {
  const address = forwardedFor
    ?.split(",")
    .at(-1)
    ?.trim()
    // IPv4 clients of a dual-stack socket appear as `::ffff:a.b.c.d`.
    .replace(/^::ffff:/i, "")
    .replace(/%.*$/, "")
    .toLowerCase()
  if (!address) return false
  if (address === "::1" || address.startsWith("127.")) return true
  return Object.values(interfaces).some((entries) =>
    entries?.some((entry) => entry.address.toLowerCase() === address)
  )
}

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
