/** Validates and fetches public HTTP(S) sources with pinned, bounded network reads. */

import { lookup } from "node:dns/promises"
import type { LookupAddress, LookupOptions } from "node:dns"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { isIP } from "node:net"
import { SourceIngestionError } from "./errors.ts"

/** DNS resolver shape injected by tests or a deployment-specific network boundary. */
export type PublicUrlResolver = (hostname: string) => Promise<readonly string[]>

/** Options that bound public source URL validation and response reads. */
export interface PublicUrlFetchOptions {
  /** Maximum response bytes to retain. */
  maxBytes?: number
  /** Maximum total time for DNS, headers, redirects, and body, in milliseconds. */
  timeoutMs?: number
  /** Maximum number of validated redirects to follow. */
  maxRedirects?: number
  /** Resolver used to reject private or local DNS answers. */
  resolve?: PublicUrlResolver
  /** Fetch implementation injected by tests; the default uses pinned Node transport. */
  fetchImpl?: typeof fetch
}

/** Fetched public source bytes and the final validated URL. */
export interface PublicSourceResponse {
  /** Final URL after validated redirects. */
  url: string
  /** Server-declared media type, if present. */
  contentType: string | null
  /** Bounded response bytes. */
  bytes: Uint8Array
}

/** A response body supplied by either Node's pinned transport or a test fetch. */
type ResponseBody =
  ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null

/** The small response surface needed by bounded body handling. */
interface SourceResponse {
  status: number
  headers: Headers
  body: ResponseBody
  arrayBuffer?: () => Promise<ArrayBuffer>
  cancel?: () => void
}

/** A URL plus the address used for its pinned network connection. */
interface ValidatedPublicUrl {
  url: URL
  address: string
}

/** Default DNS resolver that returns every address for a hostname. */
async function resolveAll(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map((answer) => answer.address)
}

/** Converts an IPv4 string to four octets when it is syntactically valid. */
function ipv4Octets(address: string): number[] | null {
  const octets = address.split(".").map((part) => Number(part))
  return octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : null
}

/** Converts a supported IPv6 string to sixteen bytes for range checks. */
function ipv6Bytes(address: string): number[] | null {
  const normalized = address.toLowerCase().split("%", 1)[0]
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":")
    const tail = ipv4Octets(normalized.slice(separator + 1))
    if (!tail) return null
    const prefix = normalized.slice(0, separator)
    const converted = `${prefix}:${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`
    return ipv6Bytes(converted)
  }
  const halves = normalized.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":") : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  if (
    left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  )
    return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ].flatMap((part) => [part >> 8, part & 255])
}

/** Returns whether an address is globally routable enough for public source import. */
export function isPublicIp(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const octets = ipv4Octets(address)
    if (!octets) return false
    const [a, b, c] = octets
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }
  if (family !== 6) return false
  const bytes = ipv6Bytes(address)
  if (!bytes) return false
  const isUnspecified = bytes.every((byte) => byte === 0)
  const isLoopback =
    bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1
  const isUniqueLocal = (bytes[0] & 0xfe) === 0xfc
  const isLinkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80
  const isMulticast = bytes[0] === 0xff
  const isIpv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0)
  const isDocumentation =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  const isBenchmarking =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x02
  const isMappedV4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 255 &&
    bytes[11] === 255
  return !(
    isLoopback ||
    isUnspecified ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isIpv4Compatible ||
    isDocumentation ||
    isBenchmarking ||
    (isMappedV4 &&
      !isPublicIp(
        bytes
          .slice(12)
          .map((byte) => String(byte))
          .join(".")
      ))
  )
}

/** Returns milliseconds remaining before a source request deadline expires. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

/** Races an asynchronous network operation against the single source deadline. */
async function untilDeadline<T>(
  operation: Promise<T>,
  deadline: number
): Promise<T> {
  const timeout = remainingMs(deadline)
  if (timeout <= 0) {
    throw new SourceIngestionError(
      "url-timeout",
      "Source URL request timed out"
    )
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new SourceIngestionError(
                "url-timeout",
                "Source URL request timed out"
              )
            ),
          timeout
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Parses and validates an HTTP(S) URL before any network request is made. */
async function resolveValidatedPublicUrl(
  value: string,
  resolve: PublicUrlResolver,
  deadline?: number
): Promise<ValidatedPublicUrl> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new SourceIngestionError("invalid-url", "Source URL is invalid")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SourceIngestionError(
      "invalid-url",
      "Source URL must use HTTP or HTTPS"
    )
  }
  if (url.username || url.password) {
    throw new SourceIngestionError(
      "invalid-url",
      "Source URL must not include login information"
    )
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new SourceIngestionError(
      "invalid-url",
      "Source URL must use its standard HTTP(S) port"
    )
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new SourceIngestionError(
      "private-url",
      "Source URL points to a local hostname"
    )
  }
  const lookupOperation = isIP(hostname)
    ? Promise.resolve<readonly string[]>([hostname])
    : Promise.resolve().then(() => resolve(hostname))
  let addresses: readonly string[]
  try {
    addresses = deadline
      ? await untilDeadline(lookupOperation, deadline)
      : await lookupOperation
  } catch (error) {
    if (error instanceof SourceIngestionError) throw error
    throw new SourceIngestionError(
      "url-resolution-failed",
      "Source URL hostname could not be resolved",
      { hostname }
    )
  }
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw new SourceIngestionError(
      "private-url",
      "Source URL does not resolve to a public address",
      { hostname }
    )
  }
  return { url, address: addresses[0]! }
}

/** Validates a public URL and returns its normalized URL without exposing its DNS address. */
export async function validatePublicHttpUrl(
  value: string,
  resolve: PublicUrlResolver = resolveAll
): Promise<URL> {
  return (await resolveValidatedPublicUrl(value, resolve)).url
}

/** Converts Node response headers to the platform Headers type. */
function toHeaders(
  headers: Record<string, string | string[] | undefined>
): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined)
      result.set(name, Array.isArray(value) ? value.join(", ") : value)
  }
  return result
}

/** Performs a request through the validated address while retaining the URL hostname for SNI and Host. */
function requestPinned(
  url: URL,
  pinnedAddress: string,
  deadline: number
): Promise<SourceResponse> {
  return new Promise((resolve, reject) => {
    const requestFunction =
      url.protocol === "https:" ? httpsRequest : httpRequest
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const port = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80
    const timeout = remainingMs(deadline)
    if (timeout <= 0) {
      reject(
        new SourceIngestionError("url-timeout", "Source URL request timed out")
      )
      return
    }
    let settled = false
    const request = requestFunction(
      {
        hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: url.host, Accept: "*/*" },
        servername: hostname,
        lookup: (
          _lookupHostname: string,
          _lookupOptions: LookupOptions,
          callback: (
            error: NodeJS.ErrnoException | null,
            address: string | LookupAddress[],
            family?: number
          ) => void
        ) => {
          const family = isIP(pinnedAddress)
          if (_lookupOptions.all) {
            callback(null, [{ address: pinnedAddress, family }])
          } else {
            callback(null, pinnedAddress, family)
          }
        },
      },
      (response) => {
        settled = true
        clearTimeout(timer)
        resolve({
          status: response.statusCode ?? 0,
          headers: toHeaders(response.headers),
          body: response,
          cancel: () => response.destroy(),
        })
      }
    )
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      request.destroy(new Error("Source URL request timed out"))
      reject(
        new SourceIngestionError("url-timeout", "Source URL request timed out")
      )
    }, timeout)
    request.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(
        new SourceIngestionError(
          "url-fetch-failed",
          "Source URL request failed",
          { reason: error.message.slice(0, 120) }
        )
      )
    })
    request.end()
  })
}

/** Cancels an unread response body so redirect and error responses do not keep sockets open. */
async function discardResponseBody(response: SourceResponse): Promise<void> {
  if (response.cancel) {
    response.cancel()
    return
  }
  if (!response.body || !("getReader" in response.body)) return
  const reader = response.body.getReader()
  try {
    await reader.cancel()
  } finally {
    reader.releaseLock()
  }
}

/** Reads a response body with a hard byte cap and the source-wide deadline. */
async function readBoundedBody(
  response: SourceResponse,
  maxBytes: number,
  deadline: number
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? "NaN")
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardResponseBody(response)
    throw new SourceIngestionError(
      "url-too-large",
      "Source response exceeds the byte limit",
      { maxBytes }
    )
  }
  if (!response.body) {
    const bytes = response.arrayBuffer
      ? new Uint8Array(await untilDeadline(response.arrayBuffer(), deadline))
      : new Uint8Array()
    if (bytes.byteLength > maxBytes)
      throw new SourceIngestionError(
        "url-too-large",
        "Source response exceeds the byte limit",
        { maxBytes }
      )
    return bytes
  }

  const parts: Uint8Array[] = []
  let total = 0
  if ("getReader" in response.body) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const next = await untilDeadline(reader.read(), deadline)
        if (next.done) break
        total += next.value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new SourceIngestionError(
            "url-too-large",
            "Source response exceeds the byte limit",
            { maxBytes }
          )
        }
        parts.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    const iterator = response.body[Symbol.asyncIterator]()
    try {
      while (true) {
        const next = await untilDeadline(iterator.next(), deadline)
        if (next.done) break
        total += next.value.byteLength
        if (total > maxBytes) {
          await iterator.return?.()
          throw new SourceIngestionError(
            "url-too-large",
            "Source response exceeds the byte limit",
            { maxBytes }
          )
        }
        parts.push(next.value)
      }
    } finally {
      // Destroy a timed-out stream before awaiting iterator shutdown; a pending
      // network read otherwise prevents return() from finishing.
      response.cancel?.()
      await iterator.return?.()
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

/** Fetches a public HTTP(S) source using a pinned address and bounded total work. */
export async function fetchPublicSource(
  value: string,
  options: PublicUrlFetchOptions = {}
): Promise<PublicSourceResponse> {
  const maxBytes = options.maxBytes ?? 5_000_000
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? 3
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0
  ) {
    throw new SourceIngestionError(
      "invalid-input",
      "Public source fetch limits are invalid"
    )
  }
  const fetchImpl = options.fetchImpl
  const resolve = options.resolve ?? resolveAll
  const deadline = Date.now() + timeoutMs
  let current = value
  const seen = new Set<string>()
  for (
    let redirectCount = 0;
    redirectCount <= maxRedirects;
    redirectCount += 1
  ) {
    const { url, address } = await resolveValidatedPublicUrl(
      current,
      resolve,
      deadline
    )
    if (seen.has(url.href))
      throw new SourceIngestionError(
        "url-redirect-limit",
        "Source URL redirect loop detected"
      )
    seen.add(url.href)
    let response: SourceResponse
    if (fetchImpl) {
      const controller = new AbortController()
      try {
        response = await untilDeadline(
          fetchImpl(url, { redirect: "manual", signal: controller.signal }),
          deadline
        )
      } catch (error) {
        controller.abort()
        if (
          error instanceof SourceIngestionError &&
          error.code === "url-timeout"
        )
          throw error
        throw new SourceIngestionError(
          "url-fetch-failed",
          "Source URL request failed",
          {
            reason:
              error instanceof Error ? error.message.slice(0, 120) : "unknown",
          }
        )
      }
    } else {
      response = await requestPinned(url, address, deadline)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      await discardResponseBody(response)
      if (!location || redirectCount === maxRedirects)
        throw new SourceIngestionError(
          "url-redirect-limit",
          "Source URL has too many redirects",
          { maxRedirects }
        )
      try {
        current = new URL(location, url).href
      } catch {
        throw new SourceIngestionError(
          "invalid-url",
          "Source URL redirect is invalid"
        )
      }
      continue
    }
    if (!response.status || response.status < 200 || response.status >= 300) {
      await discardResponseBody(response)
      throw new SourceIngestionError(
        "url-fetch-failed",
        "Source URL returned an error",
        { status: response.status }
      )
    }
    try {
      const bytes = await readBoundedBody(response, maxBytes, deadline)
      return {
        url: url.href,
        contentType: response.headers.get("content-type"),
        bytes,
      }
    } catch (error) {
      await discardResponseBody(response)
      throw error
    }
  }
  throw new SourceIngestionError(
    "url-redirect-limit",
    "Source URL has too many redirects",
    { maxRedirects }
  )
}
