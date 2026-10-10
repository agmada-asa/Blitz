# TODO

Live tracker for the overhaul described in `docs/overhaul-plan.md`. Each item
names the PR that delivers it once one exists.

## Phase 0: it just runs

- [x] Diagnose why `dev:lan` stops persisting: any child exit stopped the
      whole stack, the browser Convex URL was pinned to the startup Wi-Fi
      address, and `convex dev` survives its database dying
- [x] One shared supervisor with backoff restarts for every service and a
      liveness watchdog for Next and Convex
- [x] `Reconnecting to Blitz…` notice while the live connection is down
- Moved to Phase 1: the benchmark (uploads still queue the old batch
  generation) and worker consolidation (most workers are being removed)

## Phase 1: Teach

- [x] Benchmark script over the school materials fixture (`npm run benchmark:teach`)
- [x] Module and unit data model
- [x] Uploads filed into units, titled from filenames, renamed by the tutor
- [x] `.vtt` and `.srt` transcripts with timestamp anchors
- [x] Teach session: outline, streamed sections, resume, citations
- [x] Interactive block protocol and renderers (quiz, steps, viz, followups)
- [x] Quick replies and inline questions in a session
- [x] Lesson quizzes saved as learning items and study events
- [ ] Remove batch generation, old Learn, concept map UI, legacy card chat
- [ ] Single prompts module
- [ ] Whole-textbook sources: batched chunk writes, chapter-sized units
- [ ] Research imports into units with passages
- [ ] Consolidate the remaining workers into one supervised process
- [ ] Share one server Convex client helper across API routes (new code uses `lib/server/convex.ts`)

## Phase 2: practice and exam mode

- [ ] Question bank per unit with all question types
- [ ] Per-concept weakness model and drills
- [ ] Relearn from practice into a focused teach session
- [ ] Past paper import and mock exams
- [ ] Long answer grading against sources

## Phase 3: home feed and habit

- [ ] Weakness-weighted infinite feed of studied material
- [ ] Streaks, XP, daily prompt
- [ ] Progress visuals and session summaries

## Known issues

- Four model-settings tests fail on `main` as well
  (`ai-model-settings`, `codex-models`, `provider-capabilities`). Fix during
  the prompts and provider cleanup.

## Phase 4: chat

- [ ] `Agent` toggle, off by default
- [ ] Chat actions into units, questions, and lessons
- [ ] Citations for every source type

## Phase 5: polish and redesign

- [ ] Redesign starting from the Teach screen
- [ ] Podcasts from units

## Phase 6: mobile and sync

- [ ] Hosted Convex option, offline cache, React Native on new contracts
