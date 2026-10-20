# Practice, the feed, and progress

Practice turns what was taught into exam readiness. Every question is an
ordinary learning item, so answers from Teach quizzes, drills, timed tests, and
the Review feed all update the same per-concept review history.

## Question banks

Each unit has a question bank. `POST /api/practice/generate` records a run in
`questionGenerations` and returns at once; `lib/server/question-bank.ts` writes
the questions after the response with `after()`. The prompt
(`buildQuestionBankPrompt` in `lib/practice.ts`) carries the unit's material,
the sections taught so far, weak concepts, existing concept names to reuse, and
existing questions to avoid. The reply is JSON in the lesson quiz format plus
one short recap per concept. `parseQuestionBank` validates each question with
the same rules as lesson quizzes; invalid ones are dropped and counted.
`extractJsonObject` repairs LaTeX backslashes the model leaves unescaped, which
used to fail whole batches.

Most questions are single choice or multiple answer, because that is what the
exams ask. About a quarter use the recall formats where they fit: cloze for a
key term or value, ordering for real sequences, matching for paired facts, and
code output for short deterministic programs (see `docs/learning-core.md` for
how each is scored). Ordering and matching items are shuffled with a stable
seed, so the browser and server always agree on the order shown.

A unit's first bank starts automatically, once, as soon as its Teach session
has an outline (`startFirstQuestionBank`, called from the chat route), so
Practice and Review have questions by the time the pre-check is done. When the
outline lists concepts, every generated question is tagged with one of them.
Later batches are written on request from the Practice screen.

## Saving chat quizzes

A quiz in a chat reply can join a unit's question bank. When the chat belongs
to a module, each finished quiz offers **Save to practice** with the module's
units (the chat's own unit, or the one studied most recently, first).
`POST /api/practice/save-quiz` re-reads the quiz from the saved reply, so the
browser only chooses which quiz and which unit, and `practice.saveChatQuiz`
stores it as a learning item with `origin: "chat"` under a concept of that
unit. Its `teachKey` (`<messageId>:<quizId>`) makes saving twice return the
same question, and `practice.chatQuizTargets` tells the chat which quizzes are
already saved. Saved questions are drilled and shown in the feed like
generated ones.

## Drills and Relearn

`/projects/[projectId]/practice/drill` asks ten questions, optionally for one
unit (`?unit=`). `practice.drill` orders them with `selectDrillQuestions`
(`lib/drill.ts`): questions answered wrongly first, then concepts due for
review, then unanswered questions on weak concepts, then the rest, avoiding the
same concept twice in a row. The deck is fetched once per drill so answering
does not reshuffle it. Answers go to `POST /api/learning/answer`.

A finished drill shows the session summary (`components/progress/session-summary.tsx`):
XP earned, accuracy, and time; each concept answered with its current strength;
today's goal and streak; then the missed questions with Relearn.
`progress.sessionSummary` counts answers and Teach milestones from the drill's
start, limited to the module and, when set, the unit.

`conceptStrength` classifies a concept as new, weak, learning, or strong from
its review history. A wrong answer offers **Relearn**, which opens the unit's
Teach screen with `?ask=` holding `relearnMessage(concept, question)`; the Teach
screen sends it once and removes it from the URL.

## Exam prep

The Practice screen's Exam prep section holds past papers and mock exams:
upload a paper (with optional solutions) or write a mock from chosen units,
then sit it against the clock and get it marked, with a per-concept breakdown
that links back to Relearn. See `docs/exam-mode.md`.

Choice questions on a paper are learning items with `origin: "exam"`. Their
answers update concept review, so drills and the feed learn from exams, but
`practice.drill`, `practice.feed`, and the unit question counts leave them out
so a paper's answers are never shown before it is taken.

## Review feed

`GET /api/learning/feed` serves `practice.feed`: questions and recaps from
units the learner has started (a Teach outline exists or a question was
answered), in drill order, with a recap placed before a question on a concept
that is not strong yet (at most one recap per two questions). Archived modules
are left out of the mixed feed. The cursor holds the item IDs already shown;
when everything has been shown, a new round begins that still skips the most
recent eight. The feed never ends.

Each visit to `/review` is a **session** with a target: the questions due
today, capped at `REVIEW_SESSION_SIZE` (20), or a round of ten when nothing is
due. The header counts answers against the target and shows the current run
of right answers; reaching the target opens the session summary, and **Keep
going** carries on with the feed. The Today panel offers the same session as
"Review 20 questions, about 7 min", with what is left after it.

About half the single-choice questions that make sense without their options
start as **recall** (`lib/learning/recall.ts`): the learner answers in their
head, taps **Show answer** (`POST /api/learning/recall`, which records
nothing), then says **I knew it** or **I didn't**, which is recorded as a
self-graded answer. **Show options** turns the card back into a normal
question. Every question, here and in Teach and drills, has an **I'm
guessing** toggle; a right guess schedules sooner (see
`docs/learning-core.md`) and the Teach pre-check treats it as not known. The
Ocean mini app's Review uses the same card through `app_answer`, `app_reveal`,
and `app_recall`.

## XP, goals, and streaks

`lib/progress.ts` defines XP: 10 per correct answer, 4 per wrong answer, 25 per
Teach section reached, and 50 per finished unit. Runs of right answers less
than 30 minutes apart earn a combo bonus (`scoreAnswers`): +2 for the third in
a row, +4 for the fourth, up to +10. The run is scored across every answer,
not per screen, so `progress.today` returns the run still going and Drills and
Review start their run counter from it. Review floats the XP each answer
earned, and session summaries take each answer's XP from the same scoring, so
their total matches the day's. Sections and units are
logged once each in `learningActivity` by `units.recordTeachProgress`, so
restarting a unit cannot earn them again.

`progress.today` groups XP by the learner's local day (the browser sends its
timezone offset). The **streak** counts consecutive days with any study; the
daily goal (default 50 XP, set under Settings) is a separate target. Every
seven streak days earn a **streak freeze** (at most two), and a day with no
study uses one instead of breaking the streak; the week chart marks it with a
snowflake. An unfinished today never breaks the streak. `progress.today` also
returns the last seven days, the Teach session to continue, and the review
session size and time estimate.

Session summaries add the best run and name up to two concepts that one to
three more right answers in a row would make strong (`answersToStrong` in
`lib/drill.ts`).

**Exam readiness** on the Practice screen (`progress.readiness`) is the share
of the module's concepts the learner would likely recall today: the mean FSRS
recall probability with never-answered concepts counted as zero, shown with
how many concepts are practised and the recall on those.

The Today panel (`components/progress/today-panel.tsx`) sits above the Library
on the start page (`/`). It links to the Teach session to continue and to a
Review session, and stays hidden until the learner has studied.

## Daily reminder

The desktop app checks every ten minutes (`electron/reminders.mjs`). At or
after the reminder hour (default 19:00, set or turned off in Settings), if
today's goal is not met and no reminder has been shown today, it shows a
native notification. Clicking it opens the unit in progress, or the Library. Browser
and `dev:lan` sessions do not send reminders.
