# Study and test sessions

Two deliberate question sessions sit beside drills (see [practice](practice.md)). Both are `StudySession` (`components/study-session/study-session.tsx`) and show one question at a time.

- **Study** (`/projects/[projectId]/practice/questions`) scores each answer as it's given and shows the explanation straight after.
- **Test** (`/projects/[projectId]/test`), linked from the Practice screen as `Timed test`, keeps answers until **Finish** and only then shows results.

Both take an optional `topicId`. `/projects/[projectId]/study` is an old link and redirects to the Practice screen.

## The deck

`GET /api/learning/session` builds the deck from `study.listStudyQuestions`. The query reads `learningItems` in order (`by_project_order`), 20 per page, and keeps single-choice, multiple-answer and true/false questions. It skips explanations, exam paper questions, malformed items and items outside the requested topic, and includes concepts already reviewed, because deliberate practice should revisit known material. It returns questions and choices without answer keys or explanations.

The route follows up to ten pages to fill a sparse deck and stops once it has `limit` questions (default 20). A cursor in the response means there are more.

## Answers

Study posts each answer to `POST /api/learning/answer` straight away; the server scores it, updates the concept's review and returns the explanation. Skipping moves on locally and sends nothing, so it can't count as wrong.

Test holds selections in memory. **Finish** submits answered questions one by one and locks the session while it does. Unanswered questions are reported as unanswered, not wrong. Each answer's idempotency key comes from `createAttemptId(sessionId, itemId, answer)` and the session keeps one timestamp, so retrying a failed Finish repeats the same requests safely; a changed answer gets a new key. If some answers fail to save, `Finish again` retries the rest.

After scoring, correct options turn green and a wrong choice red, with icons and matching accessible labels. Test shows these only on the results screen.

Every valid answer, right or wrong, counts toward the concept's answered-question total. That's separate from the review schedule; see [learning core](learning-core.md).
