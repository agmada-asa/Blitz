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
   `[m:ss]`-stamped paragraphs (`lib/transcript.ts`).
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
npm run benchmark:teach -- "<folder>" --match "Week 1" --title "COMP26120 benchmark" --teach
```

The script imports the folder into a new module as one unit and reports time
to ready per file. `--teach` also runs the first Teach turn and reports time to
first words and to the finished first section. On 10 October 2026, COMP26120
Week 1 (three transcripts, three slide PDFs) was ready in 1.8 seconds; the
first teaching text appeared about 13 seconds after opening the unit, and the
first section finished within a minute with the configured reply provider.

## Known limits

- Whole textbooks import (up to 3,000 PDF pages or 20 million characters) and
  become module-wide **reference books** when their text exceeds 600,000
  characters. Their sections are written in batches; Teach searches them each
  turn with the unit topic plus the section being taught and adds up to six
  passages as citable excerpts. A book uploaded seconds before teaching may not
  be searchable for the first turn.
- Research imports are stored as unsorted sources without passages; use
  `Group into a unit` on the module page to teach them.
- Interactive visualisations run in a sandboxed frame with no network access,
  but a script can still navigate its own frame away. Treat source-driven
  prompt injection as possible, though it cannot reach Blitz data.
