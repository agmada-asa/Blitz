/** Contains deterministic, deployment independent retrieval ranking and context bounds. */

/** Maximum chunks returned by one retrieval request. */
export const MAX_RETRIEVAL_RESULTS = 20
/** Maximum characters allowed in assembled cited context. */
export const MAX_RETRIEVAL_CONTEXT_CHARS = 16_000

/** Filters bounded chunk candidates by an exact case-insensitive phrase. */
export function rankExactCandidates<T extends { text: string }>(
  chunks: T[],
  value: string,
  maxResults = 8
): T[] {
  const needle = value.trim().toLocaleLowerCase()
  if (!needle || needle.length > 500) throw new Error("Search query is invalid")
  const limit = Math.min(
    MAX_RETRIEVAL_RESULTS,
    Math.max(1, Math.floor(maxResults))
  )
  return chunks
    .filter((chunk) => chunk.text.toLocaleLowerCase().includes(needle))
    .slice(0, limit)
}

/** Appends a cited result without allowing one large chunk to exceed the context budget. */
export function appendBoundedResult<
  T extends { text: string; citation: { sourceFilename: string } },
>(results: T[], result: T, count: number, maxChars: number): number {
  const remaining = maxChars - count
  if (remaining <= 0) return count
  const prefixLength = result.citation.sourceFilename.length + 2
  if (remaining <= prefixLength) return count
  const textBudget = remaining - prefixLength
  results.push(
    result.text.length <= textBudget
      ? result
      : { ...result, text: result.text.slice(0, textBudget) }
  )
  return count + prefixLength + Math.min(result.text.length, textBudget)
}

/** Deduplicates cited results in order while enforcing a hard context character cap. */
export function assembleRetrievedContext<
  T extends {
    text: string
    citation: { chunkId: unknown; sourceFilename: string }
  },
>(input: T[], maxChars = 8_000): { results: T[]; characterCount: number } {
  const limit = Math.min(
    MAX_RETRIEVAL_CONTEXT_CHARS,
    Math.max(500, Math.floor(maxChars))
  )
  const seen = new Set<string>()
  const results: T[] = []
  let characterCount = 0
  for (const result of input) {
    const key = String(result.citation.chunkId)
    if (seen.has(key) || characterCount >= limit) continue
    seen.add(key)
    characterCount = appendBoundedResult(results, result, characterCount, limit)
  }
  return { results, characterCount }
}
