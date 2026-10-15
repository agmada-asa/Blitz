# Blitz overhaul plan

This plan records the October 2026 requirements interview and the rebuild that
follows from it. It supersedes the feed, generation, and platform-priority
decisions in [`PRODUCT_BRIEF.md`](history/PRODUCT_BRIEF.md) where they conflict. Progress is tracked in
`TODO.md`.

## What Blitz is for

NotebookLM plus Duolingo for university modules. During term, the owner drops
in a week's transcripts, slides, and notes and is taught that material quickly,
in short sessions that fit dead time. In exam season, practice papers and
quizzes keep hitting whatever has not stuck, and a single action returns to
relearning it.

The method that already worked: put the week's material into an assistant and
say "teach me". Blitz must operationalise that loop, not put a batch pipeline
in front of it.

## Diagnosis

| Problem | Cause in the current code |
| --- | --- |
| Generation so slow the owner gave up and used ChatGPT | Learning is gated on a per-source agent job (`worker:content`) that reads every source, writes lesson drafts, validates coverage, and imports pages before anything is studyable. |
| Feed unused | The feed serves generated cards that were never taught, ignores what the learner actually struggled with, and was reduced to questions only. |
| Practice and tests never tried | They depend on Learn, which never became useful. |
| Has to keep restarting `dev:lan` | Six separate processes (Next, Convex, five workers). The supervisor restarts a crashed worker once, then gives up silently. |
| Citations weak outside PDFs | Locators exist for PDF pages; transcripts, slides, and articles have no precise anchors. `.vtt` is not supported. |
| Prompts are a mess | Prompt text is spread across generation, card chat, workspace chat, podcast, research, and teaching-voice modules with overlapping rules. |

## Decisions

- **A project is a module.** Uploads are grouped into **units** (a week or a
  lecture). New uploads update the matching unit or add a new one; they never
  require regenerating the module.
- **Teaching is live, not pre-generated.** Opening a unit starts a streamed,
  source-grounded tutor session immediately. It is a structured lesson with an
  outline you can jump around, and you can interrupt with a question at any
  point (shapes C + A from the interview).
- **Only cheap preparation is up front.** Extraction, segmentation, anchors,
  and the retrieval index are deterministic and fast. Model work happens on
  demand or in the background after teaching, never as a gate.
- **Quality over speed in model choice.** Speed comes from removing the batch
  gate, streaming, and warm sessions, not from downgrading the model. The
  learner's chosen model is used for teaching.
- **Subscriptions only, every provider.** Keep the provider compatibility layer
  (Codex, Claude Code, OpenCode, Antigravity). No API keys.
- **Interactive blocks.** Lessons and chat can contain inline quizzes, diagrams,
  maths, code, step-through worked examples, and sandboxed visualisations.
  Answers inside a lesson are real study evidence.
- **Learning evidence drives everything after teaching.** Practice, tests, the
  home feed, and review timing all read per-concept evidence from what was
  taught and answered.
- **Local first.** Keep local Convex supervised by the desktop host, with data
  boundaries that let a hosted Convex deployment become a configuration switch
  later. No accounts or social features; friends run their own copy.
- **Fresh start.** Existing generated lessons are dropped; sources are
  re-imported.
- **Cut:** concept map UI, legacy card chat (`conversations` tables and
  `worker:chat`), batch lesson generation (`worker:content`, preparation
  worker). **Repurpose:** Deep Research and written answers become exam-mode
  tools. **Keep:** chat (agent tools behind an `Agent` toggle, off by
  default), podcasts, the provider layer, ingestion, Markdown, the PDF reader.
- **Mobile is frozen** until the desktop learn, practice, and relearn loop is
  solid.

## Benchmark material

Real course material in `~/Downloads/04 Research and Education/02 School
Materials` is the acceptance fixture. It is never committed.

- **COMP26120 Week 1**: three transcripts and three slide PDFs on integer
  multiplication and complexity. Maths heavy. Primary benchmark.
- **COMP23111**: paired lecture transcripts and slides for databases. Tests
  unit grouping across many files.
- **COMP22111**: RISC-V notes and slides for ten learning videos. Tests code and
  hardware diagrams.
- **COMP24011**: lecture PDFs plus the full AIMA textbook. Tests a very large
  source that must not block anything.

Acceptance targets, measured on every relevant PR:

- Week 1 upload to unit ready to teach: under 15 seconds, excluding OCR.
- Opening a unit to the first streamed teaching text: bounded by the provider's
  first token, with no Blitz-side queueing. Recorded per provider.
- A 1,000-page textbook import never blocks teaching of other units.
- Every citation in a teach session opens the cited page, slide, or transcript
  timestamp.

## Phases

Each phase ships as one or more focused PRs from `feat/` branches, each
verified with typecheck, lint, tests, build, and a real run against the
benchmark material.

### Phase 0: it just runs

- One supervised host for Next, Convex, and a single consolidated worker
  process, with unbounded backoff restarts and a visible health indicator that
  names what is down and how to recover.
- Find and fix why `dev:lan` does not persist.
- A benchmark script that imports a fixture folder into a scratch project and
  reports timings.

### Phase 1: Teach

- Modules, units, and automatic unit grouping from filenames, transcript and
  slide pairing, and source outlines.
- Fast ingestion: `.txt` and `.vtt` transcripts with timestamps, slide and page
  anchors, article paragraph anchors.
- Teach sessions: persisted per unit, outline first, then streamed sections in
  roughly five-minute resumable chunks. Built on the existing chat streaming
  and provider stack.
- Interactive block protocol with validation and safe fallbacks: quiz (single,
  multiple, true/false), worked example steps, Mermaid, KaTeX, code, and a
  sandboxed visualisation frame.
- Quick replies (`Go deeper`, `Show an example`, `I don't get it`, `Next`) plus
  free text questions in the same session.
- Background extraction of concepts and question evidence from each session.
- A single prompts module replacing the scattered prompt text.
- Remove batch generation, the old Learn page, the concept map UI, and legacy
  card chat once Teach replaces them.

### Phase 2: practice and exam mode (target: before January exams)

- Lazily generated question bank per unit: single, multiple, true/false, cloze,
  ordering, matching, code output and tracing, maths steps, and short and long
  answers graded against sources.
- Per-concept weakness model from answers. Drills prioritise weak and due
  concepts. `Relearn` opens a focused teach session on that concept.
- Past paper import: parse questions, generate mock papers in the same style,
  timed tests, results broken down by concept.

### Phase 3: home feed and habit

- Infinite feed mixing explanations and questions drawn only from studied
  material, weighted by weakness and due reviews, filterable by module.
- Streaks, XP, a daily prompt, per-module and per-unit progress visuals, and
  session summaries.

### Phase 4: chat

- `Agent` toggle off by default; study chat stays light.
- Chat actions back into the app: make questions from this answer, add to the
  unit, quiz me on this conversation, turn this into a lesson.
- Precise citations for every source type, opening in the side pane.

### Phase 5: polish and redesign

- A visual redesign applied surface by surface, with the new Teach screen as
  the reference.
- Podcasts kept and fed from units.

### Phase 6: mobile and sync

- Hosted Convex as an option, an offline cache of taught material and queued
  answers, and the React Native app on the new contracts.

## Risks

- **Provider startup latency.** Codex and Claude Code sessions take seconds to
  start. Mitigation: start the session when a unit is opened, before the learner
  presses anything, and reuse it across sections.
- **Model output for interactive blocks.** Models will sometimes emit invalid
  blocks. Every block is validated and falls back to readable Markdown.
- **Local Convex durability.** Phase 0 must establish whether data loss or only
  process loss is behind "does not persist".
- **Scope.** Phases 1 and 2 are the product. Later phases do not start until
  the benchmark loop works end to end.
