/**
 * Chooses the Convex address a browser should use for a local Blitz install.
 *
 * Local Convex listens on every interface, but the URL baked into the build
 * names one host. Pinning a Wi-Fi address breaks the app when the Mac changes
 * networks, and pinning loopback breaks phones. Pointing a local URL at the
 * hostname that served the page keeps both working. Hosted deployments are
 * returned unchanged.
 */

/** Hostnames that identify a deployment running on the user's own machine. */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * Returns whether a hostname names loopback, a private LAN, or a Tailscale peer.
 * @param hostname Hostname from a parsed URL, without a port.
 */
export function isLocalHostname(hostname: string): boolean {
  if (
    loopbackHosts.has(hostname) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".ts.net")
  )
    return true
  const octets = hostname.split(".").map(Number)
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false
  const [first, second] = octets
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    // Tailscale and other CGNAT overlays.
    (first === 100 && second >= 64 && second <= 127)
  )
}

/**
 * Rewrites a local Convex URL to the page's hostname, keeping its port.
 * @param configuredUrl The `NEXT_PUBLIC_CONVEX_URL` value from the build.
 * @param pageHostname The hostname the page was loaded from, or undefined during server rendering.
 * @returns The configured URL when it is hosted, unparseable, or no page hostname is known.
 */
export function resolveBrowserConvexUrl(
  configuredUrl: string,
  pageHostname: string | undefined
): string {
  if (!pageHostname) return configuredUrl
  let url: URL
  try {
    url = new URL(configuredUrl)
  } catch {
    return configuredUrl
  }
  if (!isLocalHostname(url.hostname) || !isLocalHostname(pageHostname))
    return configuredUrl
  url.hostname = pageHostname
  return url.toString().replace(/\/$/, "")
}
