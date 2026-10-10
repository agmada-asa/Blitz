# Learning core

`lib/learning` contains the shared rules used by a home feed and focused study
activities. It accepts plain TypeScript data, so browser and React Native code
can share it without importing Convex, React, or an AI client.

## Questions and answer scoring

The normal question formats are `single-choice`, `multiple-answer`, and
`true-false`. A written question has `type: "written"` and must have
`context: "project-activity"`. This keeps typing out of the casual feed while
leaving it available to a deliberately chosen project activity.

`evaluateAnswer` returns `correct`, `incorrect`, or `invalid`. Invalid answers
do not count as wrong answers. A multiple-answer response must contain the
exact set of correct option IDs. Order does not matter, but duplicate IDs are
invalid, and selecting only some of the correct options is incorrect. Unknown
option IDs are invalid. Written answers use trimmed, lower-case text with
repeated whitespace collapsed, then compare exactly with the accepted answers.

Four structured formats are answered with a list of strings rather than a
choice:

- `cloze`: a prompt with numbered blanks (`{{1}}`, `{{2}}`, …) and accepted
  answers per blank. `normalizeBlankAnswer` ignores case, spaces, surrounding
  quotes or backticks, and a trailing full stop, so `O(n)` matches `o( n ).`.
  The answer lists one string per blank; at least one must be filled.
- `ordering`: every option ID in the learner's order; correct only when it
  matches `correctOrder` exactly.
- `matching`: the chosen option ID for each prompt, in prompt order; every
  prompt needs a match. Options may include unused extras.
- `code-output`: one string compared with the accepted outputs after
  `normalizeOutputAnswer`, which ignores line endings, trailing spaces, runs of
  spaces, and blank lines at either end. Case and line breaks still count.

A list of the wrong length, an unknown or repeated option ID, or an unmatched
prompt is invalid rather than wrong. `lib/interactive-blocks.ts` grades the
same formats in the browser by converting a quiz with `structuredQuestion`.

The evaluator has no side effects. A caller should record review evidence only
for a scored result, using `outcome: "correct"` or `outcome: "incorrect"`.

## Review scheduling

`createReviewState` starts a concept as immediately due. `applyReviewEvent`
changes state only for answer events. Correct answers schedule the next review
at one day, three days, seven days, fourteen days, then thirty days after the
answer, with the thirty-day interval capped for later correct streaks.
Incorrect answers reset the consecutive-correct count and retry after ten
minutes. The counters and timestamps make the rule easy to inspect and sync.

`skip` and `exposure` return the state unchanged. Reading, scrolling, and
skipping therefore cannot become mastery evidence or an automatic wrong
answer. A late synced answer is applied at the latest known answer timestamp
so it cannot move a due date backwards.

This is a small initial heuristic. It does not claim to predict mastery or
replace validated spaced-repetition research.

## Feed selection

`selectFeedItems` filters candidates by project and topic, drops review items
that are not due, and returns at most `limit` entries. It alternates due review
and new material when both are available. Due reviews are ordered by overdue
time, incorrect-answer count, age of the last answer, and stable producer
order. New items use producer order and creation time. Input order resolves
remaining ties, so repeated calls with the same input are deterministic.

Candidates may provide `format: "explanation"` or `format: "question"`. When
both formats are available, the selector uses a soft cadence of no more than
two explanations before preferring a question. It keeps the existing due/new
and concept-diversity preferences, and falls back to whichever format exists.
The cadence applies inside each bounded candidate batch; it does not promise a
global ratio when later batches lack one of the formats. Callers that omit
`format` keep the original selection behavior.

The selector prefers a different concept after the previous item and avoids
recent concepts when another candidate is available. If every remaining item
belongs to the same concept, it still returns those items so an otherwise
usable feed does not become empty. Empty input, a non-positive limit, filters
with no matches, and an input with no due reviews all return a predictable
result. With no due reviews, available new material can still fill the feed.
