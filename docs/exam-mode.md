# Exam mode

Exam mode lets a learner sit past papers and mock exams against the clock,
have them marked, and go straight from a weak concept to relearning it. It
lives in the **Exam prep** section of the Practice screen and at
`/projects/[projectId]/practice/exam/[paperId]`.

## Flow

1. **Add a past paper.** `components/practice/exam-dialogs.tsx` uploads the
   paper (and optionally solutions or a mark scheme) to
   `POST /api/sources/upload` without `x-blitz-unit-id`. Each file becomes an
   ordinary module source with extracted text and passages, but no unit, so it
   is never taught. Paper sources are left out of the module page's unsorted
   list. The dialog then calls `POST /api/practice/exam/papers`, which records
   an `examPapers` row (`kind: "past"`, `status: "processing"`) and returns at
   once; the questions are extracted after the response with `after()`.
2. **Write a mock exam.** The learner picks units (all units with readable
   material by default) and 30, 60, or 90 minutes. `POST /api/practice/exam/mock`
   records a `kind: "mock"` paper and writes it after the response. Only one
   mock is written per module at a time.
3. **Background run.** `runPaperPreparation` in `lib/server/exam.ts` loads
   `exam.paperContext`, makes one provider turn (the task selection used for
   practice questions, in an empty read-only temporary directory with no web
   search), validates the reply with `parseExamPaper`, and saves it with
   `exam.savePaper`. Failures are saved on the paper with a learner-facing
   message; `POST /api/practice/exam/retry` restarts a failed or stalled run.
4. **Take the paper.** The start screen shows the questions, marks, and time
   (a past paper with no stated time offers 30 to 120 minutes).
   `exam.startAttempt` creates an `examAttempts` row with a deadline, or
   returns the open one. The paper shows every question in order with a
   countdown. Answers autosave through `exam.saveAnswers` shortly after each
   change, so a reload or a second tab resumes the same attempt.
5. **Submit.** `POST /api/practice/exam/submit` calls `exam.submitAttempt`,
   which saves the final answers and marks choice questions in the same Convex
   mutation (`scoreAttempt` in `lib/exam-scoring.ts`). When the countdown
   reaches zero the browser submits automatically, including when the learner
   returns after the deadline, and the results say so. Answers arriving more
   than a minute after the deadline are ignored in favour of the saved ones.
6. **Evidence and marking.** After the response, every answered choice
   question is recorded with `learning.recordAnswerEvent` (event id
   `exam:<attemptId>:<questionId>`, time of submission, so retries are
   idempotent). Written answers are then marked by `runExamGrading` in one
   provider turn. If marking fails, the results show the choice-question marks
   and `POST /api/practice/exam/grade` retries it.
7. **Results.** `?attempt=<id>` shows the score, the marking state, a
   per-concept breakdown sorted weakest first (`conceptBreakdown`) with a
   Relearn link to the concept's unit when one matched, and every question
   with the learner's answer, the correct or model answer, the mark scheme,
   and feedback.

## Editing and deleting

Both are refused while a paper is being prepared or written answers on one of
its attempts are being marked (`ExamChangeLock` in `lib/exam-scoring.ts`;
stalled runs past their lease no longer block). The screens show the reason
instead of the action.

- **Edit questions.** The paper's menu (on its page and in the Exam prep list)
  links to `?edit=1`, which shows `components/practice/exam-editor.tsx`:
  every question with its answer, explanation or model answer and mark
  scheme, and concept. Answers are visible there, so the screen says so. Each
  question opens in a dialog that edits the number, marks, concept, wording,
  options and correct options (and switches between one and more than one
  correct answer), the true or false answer, the explanation, or the model
  answer and mark scheme. Other format changes are not allowed.
- **Validation.** `POST /api/practice/exam/questions` checks the edit with
  `validateQuestionEdit` in `lib/exam.ts`, which gives a specific message for
  each problem and then runs the extractor's own question parser
  (`parseExamQuestion`, which reuses the lesson quiz rules). Unlike
  extraction, nothing is filled in or dropped: marks, a number, a concept, an
  explanation, and complete mark scheme points are required, and the wording
  may not repeat another question on the paper. `exam.updateQuestion`
  re-checks the bounds and answer key before saving, as `exam.savePaper`
  does.
- **What an edit changes.** The question keeps its id, unit, and learning
  item. The item's question, options, answer key, explanation, and concept
  are updated, so later evidence is checked against the new key; answers
  already recorded keep their outcome. Each option the editor sends names the
  option it came from, so saved selections follow their option when options
  are added, removed, or reworded (`optionIdMap`, `remapAnswers`). Submitted
  attempts are marked again (`rescoreResults`): choice questions against the
  new key, deterministically; written answers keep the marks and feedback
  they were given, clamped to the question's new marks, because marking them
  again would need another model run. The editor says this when the paper has
  attempts. Changing a past paper question's answer clears its answer source,
  since the learner set it rather than the solutions or the model.
- **Delete a question.** `exam.deleteQuestion` removes it from the paper and
  from every attempt's answers and results, and updates the totals. Question
  ids are not renumbered, so other answers keep pointing at their question. A
  paper keeps at least one question.
- **Delete a paper.** `exam.deletePaper` deletes the paper's attempts (with
  their marks, including one in progress). A mock paper's row is removed. A
  past paper's row is kept, emptied, with `deletedAt` set and status
  `failed`, because `units.listForProject` hides a module's paper files only
  while a paper refers to them; without it, the uploaded paper and solutions
  would appear as unsorted material that could be taught. Every exam view and
  the notification center skip deleted papers, and adding the same file again
  starts that paper afresh.
- **Learning items are archived, not deleted.** Deleting a question or paper
  sets `archivedAt` on its learning items. Answer events and concept reviews
  refer to those items, so archiving keeps study history and concept
  strengths consistent while taking the items out of every live view, which
  already skips archived items.

## Data

- `examPapers`: module, kind, title, status and error, the paper and solutions
  source IDs (past) or unit IDs (mock), time allowed, stated and summed total
  marks, and the questions. `runStartedAt` identifies the current run and acts
  as a ten-minute lease; a run that saves late after a retry is ignored.
  `deletedAt` marks a deleted past paper (see above).
- Each question has an id (`q1`, `q2`, … in paper order, with gaps once a
  question is deleted), the printed number,
  marks (half marks allowed), type (`single-choice`, `multiple-answer`,
  `true-false`, or `written`), a Markdown prompt (code and LaTeX allowed), a
  concept name, and the matched unit when there is one. Choice questions carry
  options, correct option IDs, an explanation, and their learning item. Written
  questions carry a model answer and a mark scheme of key points with marks.
  Past paper questions record `answerSource: "solutions" | "inferred"`.
- `examAttempts`: the paper, status (`in_progress` or `submitted`), deadline,
  autosaved answers, results per question (`unanswered`, `correct`,
  `incorrect`, `pending`, or `marked`, with awarded marks and feedback),
  whether time ran out, the grading run's status and lease, and the marks
  awarded so far.
- Choice questions become `learningItems` with `origin: "exam"` when a paper
  is ready, under the matched concept and unit. They update concept review
  like any answer, but `practice.drill`, `practice.feed`, and the older study
  sessions skip them so a paper's answers are never shown before it is taken.
  They do count toward a unit's concept strengths on the Practice screen.
- `exam.paperSession` never returns answer keys, explanations, model answers,
  or mark schemes for a paper being sat; they are only returned in the review
  of a submitted attempt and by `exam.editorSession` for the question editor.

## Prompts and validation

All prompts and parsers live in `lib/exam.ts` and are covered by
`tests/exam.test.ts`.

- **Past paper extraction** (`buildPastPaperPrompt`): the paper and solutions
  share a 160,000 character budget fairly (`budgetSources`), plus the module's
  units (keyed U1, U2, …) with their concept names so each question can be
  matched to a unit and reuse an existing concept. Multi-part questions are
  split into standalone parts.
- **Mock papers** (`buildMockExamPrompt`): the selected units' extracted text
  shares a 200,000 character budget, weak concepts in those units
  (`conceptStrength`) get more questions, and up to two ready past papers (25
  questions each, prompts shortened) are included as style examples.
  `mockBlueprint` sets the number of choice and written questions and their
  typical marks: from the past papers' questions per minute and marks per
  question when there are any, otherwise about one one-mark choice question
  per 2.5 minutes and one eight-mark written question per 30 minutes.
- **Validation** (`parseExamPaper`): choice questions reuse the lesson quiz
  rules (`parseInteractiveBlock`), with the prompt checked separately against
  the longer exam limit. Every string and list is bounded (`EXAM_LIMITS`),
  marks must be 0.5 to 100, written questions need a model answer and at least
  one mark scheme point, unknown unit keys are dropped, an answer can only
  claim to come from solutions when solutions were uploaded, and duplicate
  prompts are removed. Invalid questions are dropped and counted; at most 60
  questions are kept.
- **Grading** (`buildExamGradingPrompt`, `parseExamGrading`): each written
  answer is sent with its question, mark scheme, and model answer; answers
  share a 60,000 character budget and are marked as untrusted. Grades for
  unknown or repeated questions and grades without feedback are dropped; marks
  are rounded to half marks and clamped to `0..max`. If any answer is left
  without a valid grade, the run fails and can be retried.

## Limits

- Scanned papers without selectable text cannot be read; the paper fails with
  a message saying so. There is no OCR yet.
- Figures are described in words by the model or the question is left out.
- Multiple-answer choice questions are marked all or nothing, as in drills.
- Choice-question answers from a past paper without solutions are the model's
  best answer and are labelled as worked out without solutions.
- Editing a written question's mark scheme does not mark earlier written
  answers again.
- A paper's uploaded files stay stored after the paper is deleted; there is no
  way to delete a source yet.
- Only three provider turns exist: one per paper extraction, one per mock, and
  one per grading run.
