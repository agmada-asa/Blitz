# Learning core

`lib/learning/` holds the rules every study surface shares: how an answer is scored, how a concept is scheduled for review, and the contracts clients use. It takes plain TypeScript data, so it doesn't import Convex, React or an AI client. `convex/learning.ts` applies the same rules on the server when answers are saved.

## Learning items

Everything a learner answers is a `learningItems` row. Each belongs to one project and concept, usually a unit, and cites at least one source. Its `origin` says where it came from: `teach`, `bank`, `chat` or `exam`. Items come from question banks and their recaps (`practice.saveGeneratedQuestions`), Teach quizzes (`teach.registerQuiz`), quizzes saved from chat (`practice.saveChatQuiz`) and exam papers. `convex/quizFields.ts` maps a parsed quiz onto the item fields for all of them.

Item types are `explain`, `single-choice`, `multiple-answer`, `true-false`, `cloze`, `ordering`, `matching` and `code-output`. Ordering keeps the correct sequence in `correctOptionIds`, matching keeps the answer for each of its `matchPrompts` there, and cloze and code output keep theirs in `acceptedAnswers`. Answer keys stay on the server; cards sent to the browser leave them out until the answer has been scored.

A written question has `type: "written"` and must have `context: "project-activity"`, which keeps typing out of the casual feed. See [written practice](written-practice.md).

## Scoring an answer

`evaluateAnswer` returns `correct`, `incorrect` or `invalid`. An invalid answer is never counted as wrong.

- **Single choice and true/false**: the chosen option must be the correct one.
- **Multiple answer**: the exact set of correct option IDs, in any order. Some but not all correct is wrong; duplicate or unknown IDs are invalid.
- **Cloze**: numbered blanks (`{{1}}`, `{{2}}`, …), one answer per blank, at least one filled. `normalizeBlankAnswer` ignores case, spaces, surrounding quotes or backticks and a trailing full stop, so `O(n)` matches `o( n ).`.
- **Ordering**: every option ID in the learner's order; correct only if it matches `correctOrder` exactly.
- **Matching**: one option ID per prompt, in prompt order; every prompt needs a match, and options may include unused extras.
- **Code output**: compared after `normalizeOutputAnswer`, which ignores line endings, trailing spaces, runs of spaces and blank lines at either end. Case and line breaks still count.
- **Written**: trimmed, lower-cased, whitespace collapsed, then compared exactly with the accepted answers.

A list of the wrong length, an unknown or repeated option ID, or an unmatched prompt is invalid rather than wrong. `lib/interactive-blocks.ts` grades the same formats in the browser by converting a quiz with `structuredQuestion`.

## Saving answers

`learning.recordAnswerEvent` takes an item ID, a timestamp, an idempotency key and the learner's answer. It loads the stored item and scores it on the server; the client never sends correctness, counts or due dates. An invalid answer returns `invalid` and records nothing. A scored answer is saved to `studyEvents` with its outcome, so replaying it later doesn't depend on later edits to the item. It returns the outcome, the new review state, and feedback with the explanation and correct answer.

`learning.recordPassiveEvent` accepts only `skip` and `exposure`. They are saved but never change a review, so reading, scrolling and skipping can't count as knowing something or as a wrong answer.

`learning.recordRecallEvent` is the one answer whose outcome the learner supplies: they answered from memory, then said whether they knew it. It is saved with `answerMode: "recall"` and scheduled like any other answer.

Idempotency keys are scoped to a project. Reusing one with a different item, event type, timestamp or answer is rejected. Reordered multiple-answer arrays count as the same answer; for ordering, matching and cloze, order is part of the answer.

## Review scheduling

Scheduling uses [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) through `lib/learning/fsrs.ts`. Each concept keeps an FSRS memory (stability, difficulty, phase, reps, lapses) on its `conceptReviews` row. The next review is set for when predicted recall falls to 90%, capped at 60 days. A wrong answer is graded `Again`, a right answer marked as a guess `Hard`, and a right answer `Good`. A miss, or a guess on a new concept, comes back after ten minutes.

After each scored answer, the server rebuilds the concept's review from all its scored answers in order of when they happened (`replayReviewEvents` in `lib/learning/replay.ts`), so answers synced late or out of order land in the right place. Fuzz is off, so the same answers always give the same schedule. A late answer is applied at the latest known answer time, so it can't move a due date backwards.

The review also counts the distinct question items answered, right or wrong. Answering the same item again doesn't raise it.

`recallProbability` gives the predicted chance of recalling a concept now. Exam readiness uses it; see [practice](practice.md#xp-goals-and-streaks).

## Older code

`convex/learning.ts` still has the first feed (`getLearningFeed`, `listLearningFeedCandidates`, and `selectFeedItems` in `lib/learning/core.ts`), the `topics` table, and `createTopic`, `createConcept` and `insertLearningItems`. Nothing in the app calls them now: the Review feed is `practice.feed` (see [practice](practice.md#review-feed)), and concepts come from Teach outlines and question banks.
