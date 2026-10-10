# Teach

Teach replaces batch lesson generation. A module (project) is split into
**units**, usually a week or a lecture. Opening a unit starts a live tutor
session that teaches the unit's own material straight away, with an outline,
citations, interactive blocks, and quizzes that count as study evidence.

## Flow

1. **Add material.** `components/learn/add-material.tsx` creates a unit
   (titled by `suggestUnitTitle` from the filenames) and uploads each file to
   `POST /api/sources/upload` with `x-blitz-unit-id`. Pasted notes and links are
   uploaded as Markdown text files, so every source gets the same extraction,
   passages, and citations. A source is `ready` as soon as extraction finishes;
   there is no generation step. Subtitle files (`.vtt`, `.srt`) become
   `[m:ss]`-stamped paragraphs (`lib/transcript.ts`), and Word documents
   (`.docx`) become Markdown with their headings. Sources found with **Find
   sources** are imported into the unit the learner picks (or a new unit for
   the research) with passages, the same way uploads are; see
   `docs/research.md`. Each unit's menu on the module page opens Find
   sources with that unit picked.
2. **Open the unit.** `/projects/[projectId]/learn/[unitId]` renders
   `components/learn/teach-session.tsx`. `units.startTeach` returns the unit's
   session, a workspace chat with `purpose: "teach"`, creating it on first visit.
   An empty session sends `Teach me this unit.` automatically.
3. **Teach turns.** The Teach screen posts to the ordinary `POST /api/chat`.
   For a Teach chat, the route loads `units.teachContext`, uses the unit's
   project folder as a read-only workspace, and builds the prompt with
   `buildTeachPrompt` (`lib/teach.ts`). The first turn, or any turn whose
   provider session was lost, carries the unit's extracted text (320,000
   characters, shared fairly across files), the agreed outline, and the dialogue
   so far. Later turns send only the learner's message. Citable passages are the
   unit's chunks, ranked by `teachTurnFocus` against the section being taught.
4. **Progress.** When a turn finishes, the route parses the reply's ```outline
   and ```section blocks and calls `units.recordTeachProgress`. The first
   outline is kept, progress only moves forward, and an `auto` unit title takes
   the tutor's topic title (keeping a `Week N` prefix).
5. **Quizzes.** Answers go to `POST /api/teach/answer`, which re-reads the quiz
   from the saved reply, turns it into a learning item under a concept
   (`teach.registerQuiz`), and records the answer with
   `learning.recordAnswerEvent`. Review scheduling, Practice, and the feed read
   these like any other question. `teach.answeredQuizzes` restores answered state.

## The Teach screen

The header carries the unit title, the current section, a segmented progress
bar (one segment per section: taught, current, or ahead), the XP earned this
sitting, and **Finish for now**. On narrow screens the progress bar opens the
outline; on wide ones the outline is a rail drawn as a path, with the unit's
sources beneath it. Each section in the lesson opens with a numbered heading.

A sitting starts when the learner opens the unit and lasts until a three hour
gap (`lib/client/teach-sitting.ts`, kept in session storage so a reload keeps
it). **Finish for now** opens the session summary for the sitting
(`components/progress/session-summary.tsx`, backed by
`progress.sessionSummary`): XP, sections, accuracy, time, each concept answered
and its strength, and today's goal and streak, with Done for now, Keep
learning, and Practice this unit. Once the unit is complete, the same summary
for the whole unit appears after the recap.

### The same look elsewhere

The Teach screen's progress visuals live in
`components/progress/progress-path.tsx` and are reused across the app, so
progress always reads the same way:

- **Segmented bar** (`SegmentedBar`): one segment per section, unit, or
  concept, filled as far as it has gone. Teach and the module page draw a
  unit's sections; Home's Continue card draws the unit being resumed; Library
  cards draw one segment per unit; Practice draws one per concept, grouped by
  strength and filled by mastery.
- **Path** (`PathMarker`, `PathConnector`): numbered markers joined by a line
  that fills as steps are done. Teach's outline uses it for sections and the
  module page's learning path for units (taught, up next, ahead).

Concept strength is one colour fading out (strong, learning, needs work) with
grey for not practised, so it stays readable in every accent theme. Home also
keeps today's XP in a chip above the feed.

## Protocol

The tutor's rules live in `TEACH_RULES` in `lib/teach.ts`:

- The first reply opens with ```outline JSON (`title`, 3–8 `sections`) and then
  teaches section 1.
- Every reply that teaches a section starts with a ```section block holding the
  section id; the recap after the last section uses `done`.
- Quick replies (`TEACH_QUICK_REPLIES`) have fixed meanings: next section,
  deeper, another example, and re-explain. Any other message is a question.
- Interactive blocks (quiz, steps, viz, followups) follow
  `INTERACTIVE_BLOCKS_PROMPT` in `lib/interactive-blocks.ts`. Malformed blocks
  fall back to visible code; outline and section markers are hidden everywhere.

## Measuring speed

```bash
npm run benchmark:teach -- "<folder>" --match "Week 1" --title "Algorithms benchmark" --teach
```

The script imports the folder into a new module as one unit and reports time
to ready per file. `--teach` also runs the first Teach turn and reports time to
first words and to the finished first section. On 10 October 2026, an algorithms
module's week 1 (three transcripts, three slide PDFs) was ready in 1.8 seconds; the
first teaching text appeared about 13 seconds after opening the unit, and the
first section finished within a minute with the configured reply provider.

## Known limits

- Whole textbooks import (up to 3,000 PDF pages or 20 million characters) and
  become module-wide **reference books** when their text exceeds 600,000
  characters. Their sections are written in batches; Teach searches them each
  turn with the unit topic plus the section being taught and adds up to six
  passages as citable excerpts, cited at their page even past the 450 KB
  excerpt stored on the source row. A book uploaded seconds before teaching
  may not be searchable for the first turn.
- Research imports made before imports were filed into units are unsorted
  and have no passages. `Group into a unit` on the module page lets Teach
  teach them from their text, but they cannot be cited; add the link again
  with `Add material` to cite it.
- Citations open the cited page, slide, timestamp, or heading as described
  in `docs/chat-citations.md`. Slides and Word documents are shown as
  extracted text; their originals download.
- Interactive visualisations run in a sandboxed frame with no network access,
  but a script can still navigate its own frame away. Treat source-driven
  prompt injection as possible, though it cannot reach Blitz data.
