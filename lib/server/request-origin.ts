/** Validates browser origins across Blitz's localhost, desktop, and LAN entry points. */

/** Returns whether a hostname is one of the equivalent local loopback names. */
function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  )
}

/** Parses an HTTP origin and returns undefined for malformed or unsupported values. */
function httpOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return undefined
    return url
  } catch {
    return undefined
  }
}

/** Returns whether two origins name the same local server through loopback aliases. */
function isEquivalentLoopbackOrigin(left: URL, right: URL): boolean {
  return (
    left.protocol === right.protocol &&
    left.port === right.port &&
    isLoopbackHostname(left.hostname) &&
    isLoopbackHostname(right.hostname)
  )
}

/** Accepts the request origin when it matches the public host used to reach Blitz. */
export function isTrustedBlitzOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return true

  const originUrl = httpOrigin(origin)
  const requestUrl = httpOrigin(request.url)
  if (!originUrl || !requestUrl) return false
  if (
    originUrl.origin === requestUrl.origin ||
    isEquivalentLoopbackOrigin(originUrl, requestUrl)
  )
    return true

  const requestHost = request.headers.get("host")?.trim()
  const publicUrl = requestHost
    ? httpOrigin(`${requestUrl.protocol}//${requestHost}`)
    : undefined
  return Boolean(
    publicUrl &&
    (originUrl.origin === publicUrl.origin ||
      isEquivalentLoopbackOrigin(originUrl, publicUrl))
  )
}
