/** Fetches one approved research source through the bounded public-source boundary. */

import { SourceIngestionError } from "./source-ingestion/errors.ts"
import { fetchPublicSource } from "./source-ingestion/url.ts"
import {
  extractDownloadedSource,
  type ExtractedDownloadedSource,
} from "./source-ingestion/extract.ts"

/** Extracted source payload ready for the atomic Convex import mutation. */
export interface ResearchImportedSource extends ExtractedDownloadedSource {
  /** Original approved URL before any validated redirect. */
  originalUrl: string
}

/** Fetches and extracts one approved public source without importing it. */
export async function fetchApprovedResearchSource(
  url: string
): Promise<ResearchImportedSource> {
  const response = await fetchPublicSource(url, {
    maxBytes: 5_000_000,
    timeoutMs: 20_000,
    maxRedirects: 3,
  })
  const approvedPath = new URL(url).pathname.replace(/\/+$/, "")
  const downloadedPath = new URL(response.url).pathname.replace(/\/+$/, "")
  // Missing articles often redirect to a site's homepage with a successful HTTP status.
  // Importing that page would silently teach unrelated navigation and news instead.
  if (approvedPath && !downloadedPath)
    throw new SourceIngestionError(
      "invalid-input",
      "The approved article redirected to the site homepage",
      { reason: "redirected-to-homepage" }
    )
  const extracted = await extractDownloadedSource({
    bytes: response.bytes,
    contentType: response.contentType,
    url: response.url,
  })
  return { ...extracted, originalUrl: url }
}
