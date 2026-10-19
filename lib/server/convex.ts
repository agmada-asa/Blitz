/**
 * Creates the server-side Convex client shared by route handlers, server
 * modules, and the background worker.
 *
 * Every server caller resolves the deployment URL here so the lookup order
 * stays in one place. Callers that answer HTTP requests pass their own
 * `unavailable` error so the response keeps their feature-specific copy and
 * status code instead of exposing configuration details.
 */

import { ConvexHttpClient } from "convex/browser"

/** Builds the error a caller reports when Convex cannot be reached. */
export type ConvexUnavailableError = () => Error

/** Default error for callers that do not need feature-specific copy. */
const databaseNotConfigured: ConvexUnavailableError = () =>
  new Error("Blitz's database is not configured")

/**
 * Returns a Convex client for this machine's deployment.
 *
 * Prefers `BLITZ_CONVEX_URL`, the loopback address the launcher sets for
 * server code, then the public URLs used by older configurations
 * (`NEXT_PUBLIC_CONVEX_URL`, then `CONVEX_URL`).
 *
 * @param unavailable - Builds the error thrown when no URL is configured or
 *   the configured URL is rejected by the Convex client. Defaults to a plain
 *   "Blitz's database is not configured" error.
 * @returns A new HTTP client; it holds no connection, so creating one per
 *   request is cheap.
 * @throws The `unavailable` error when the deployment URL is missing or invalid.
 */
export function serverConvexClient(
  unavailable: ConvexUnavailableError = databaseNotConfigured
): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw unavailable()
  try {
    return new ConvexHttpClient(endpoint)
  } catch {
    // A malformed URL is a configuration problem, reported the same way as a
    // missing one so raw client errors never reach a response.
    throw unavailable()
  }
}
