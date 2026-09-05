# Study and test sessions

Blitz has two deliberate modes at `/projects/:projectId/practice` and
`/projects/:projectId/test`. Both accept an optional `topicId` query
parameter. The older `/study` route remains separate.

The session deck comes from the `listStudyQuestions` Convex query. It scans
`learningItems` through `by_project_order`, returns at most 20 rows per page,
and filters to single-choice, multiple-answer, and true-false questions. It
includes reviewed and unreviewed concepts because deliberate practice and
testing should revisit known material. It returns question text and choices,
but never the answer key or the post-answer explanation. Explanation items,
malformed items, and items outside the requested topic are skipped. The Convex
query reads one bounded page per call. The HTTP route follows at most ten
cursors, or 200 rows, to fill a sparse response without doing multiple
pagination operations inside one Convex query. A non-final cursor means this
is a limited initial deck; clients can request the cursor later.

Practice posts each selected answer to the existing `/api/learning/answer`
endpoint immediately. The server evaluates it against the stored question,
updates the concept review, and returns the explanation only after scoring.
Skip advances locally and sends no answer event, so it cannot become an
incorrect attempt.

Test keeps selections in memory until Finish. Finish submits answered
questions one by one through `/api/learning/answer`. Unanswered questions are
skipped and remain separate from incorrect results. The test locks selections
and navigation once submission starts, so a partial retry cannot change an
already submitted answer. `createAttemptId(sessionId, itemId, answer)` supplies
the same event key when one answer is retried. A changed practice answer gets
a different key, so a failed first request cannot collide with its replacement.
The session also keeps one
timestamp per mount for retries, allowing a lost response or partial Finish to
repeat the same request safely through the existing event idempotency check.

The route is intentionally a small HTTP boundary so browser and React Native
clients can share the contract. It validates identifiers and answer shapes,
limits deck pages to 20, and never accepts client-provided correctness or
review state. The scheduling and review summary remain the conservative
heuristic already used by the learning core. They are useful bookkeeping for
choosing what to show next, not a validated prediction of human mastery.

The UI shows one question at a time with a short progress indicator. It does
not record scrolling, exposure, or skip as mastery evidence. Test results list
the server result for each question and the stored explanation when one is
available.

## Verification

The live browser flow was checked at 1280 × 720 and at 390 × 844 through a
measured iframe viewport. Study returned immediate server feedback. A ten-question
test with two answers returned one correct, one incorrect, and eight unanswered;
no feedback appeared before Finish. Two-question cursor pages returned the same
ordered question IDs as the full deck, without duplicates or answer keys.


After scoring, correct options are green and selected incorrect options are red,
with check/cancel icons and equivalent accessible labels. Test mode reveals
these states only in the finished result view. Missing feedback stays neutral.
