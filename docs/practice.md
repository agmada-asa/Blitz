# Practice, the feed, and progress

Practice turns what was taught into exam readiness. Every question is an
ordinary learning item, so answers from Teach quizzes, drills, timed tests, and
the home feed all update the same per-concept review history.

## Question banks

Each unit has a question bank. `POST /api/practice/generate` records a run in
`questionGenerations` and returns at once; `lib/server/question-bank.ts` writes
the questions after the response with `after()`. The prompt
(`buildQuestionBankPrompt` in `lib/practice.ts`) carries the unit's material,
the sections taught so far, weak concepts, existing concept names to reuse, and
existing questions to avoid. The reply is JSON in the lesson quiz format plus
one short recap per concept. `parseQuestionBank` validates each question with
the same rules as lesson quizzes; invalid ones are dropped and counted.

A unit's first bank starts automatically, once, when Teach reaches its second
section (`startFirstQuestionBank`, called from the chat route). Later batches
are written on request from the Practice screen.

## Drills and Relearn

`/projects/[projectId]/practice/drill` asks ten questions, optionally for one
unit (`?unit=`). `practice.drill` orders them with `selectDrillQuestions`
(`lib/drill.ts`): questions answered wrongly first, then concepts due for
review, then unanswered questions on weak concepts, then the rest, avoiding the
same concept twice in a row. The deck is fetched once per drill so answering
does not reshuffle it. Answers go to `POST /api/learning/answer`.

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

## Home feed

`GET /api/learning/feed` now serves `practice.feed`: questions and recaps from
units the learner has started (a Teach outline exists or a question was
answered), in drill order, with a recap placed before a question on a concept
that is not strong yet (at most one recap per two questions). The cursor holds
the item IDs already shown in the session; when everything has been shown, a
new round begins that still skips the most recent eight. The feed never ends.

## XP, goals, and streaks

`lib/progress.ts` defines XP: 10 per correct answer, 4 per wrong answer, 25 per
Teach section reached, and 50 per finished unit. Sections and units are logged
once each in `learningActivity` by `units.recordTeachProgress`, so restarting a
unit cannot earn them again. `progress.today` groups XP by the learner's local
day (the browser sends its timezone offset), computes the streak of days that
met the daily goal (an unfinished today never breaks it), and returns the last
seven days, the Teach session to continue, and the number of unit concepts due
for review. The daily goal (default 50 XP) is set under Settings.

The Today card (`components/feed/today-card.tsx`) is the first page of the home
feed.

## Daily reminder

The desktop app checks every ten minutes (`electron/reminders.mjs`). At or
after the reminder hour (default 19:00, set or turned off in Settings), if
today's goal is not met and no reminder has been shown today, it shows a
native notification. Clicking it opens the unit in progress, or Home. Browser
and `dev:lan` sessions do not send reminders.
