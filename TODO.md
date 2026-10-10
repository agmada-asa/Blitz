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

- [ ] Benchmark script over the school materials fixture
- [ ] Module and unit data model; drop old generated lesson data
- [ ] Automatic unit grouping for uploads
- [ ] `.txt` and `.vtt` transcripts with timestamp anchors
- [ ] Slide, page, and paragraph anchors for citations
- [ ] Single prompts module
- [ ] Teach session: outline, streamed sections, resume
- [ ] Interactive block protocol and renderers
- [ ] Quick replies and inline questions in a session
- [ ] Background concept and evidence extraction
- [ ] Remove batch generation, old Learn, concept map UI, legacy card chat
- [ ] Consolidate the remaining workers into one supervised process
- [ ] Share one server Convex client helper across API routes

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
