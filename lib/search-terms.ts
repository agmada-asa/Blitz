/**
 * Picks the most distinctive words from a passage to use as a full-text
 * search query. Convex text search matches individual terms, so a short list
 * of topic words finds related passages better than a long sentence.
 * Dependency-free so Convex queries can import it.
 */

/** Common words that never identify a topic. */
const STOP_WORDS = new Set(
  "about above after again against also although among another anything around because been before being below between both cannot could does doing down during each either else enough even every from further have having here however into itself just least less like made make many more most much must need never only other otherwise over own perhaps rather same section should since some such than that their them then there these they this those through thus under unit until upon very want week were what when where whether which while whom whose will with within without would your lecture slides slide page transcript notes today going know think really okay right look looking first second third last next works work working using used uses show shows explain explains example examples problem problems idea ideas part basic simple introduction overview chapter".split(
    " "
  )
)

/**
 * Returns up to `max` search terms, most frequent first, ignoring short and
 * common words.
 * @param text Text describing what to search for.
 * @param max Most terms to return; Convex limits the terms in one query.
 */
export function searchTerms(text: string, max = 12): string {
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? []) {
    if (STOP_WORDS.has(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([word]) => word)
    .join(" ")
}
