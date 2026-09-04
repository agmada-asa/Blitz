/** Fetches one approved research source through the bounded public-source boundary. */

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
  const extracted = await extractDownloadedSource({
    bytes: response.bytes,
    contentType: response.contentType,
    url: response.url,
  })
  return { ...extracted, originalUrl: url }
}
