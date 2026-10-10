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
- [x] Remove batch generation, old Learn, concept map UI, legacy card chat
- [x] Prompt map (`docs/prompts.md`); dead card-generation prompt removed
- [x] Whole textbooks as module-wide reference books searched by Teach
- [ ] Research imports into units with passages
- [ ] Consolidate the remaining workers into one supervised process
- [ ] Share one server Convex client helper across API routes (new code uses `lib/server/convex.ts`)

## Phase 2: practice and exam mode

- [x] Question bank per unit (single, multiple, true/false), first bank automatic
- [x] Per-concept strength and adaptive drills
- [x] Relearn from practice into the unit's Teach session
- [x] More question types: cloze, ordering, matching, code output
- [x] Past paper import and mock exams (`docs/exam-mode.md`)
- [x] Long answer grading against sources (exam written answers, marked
      against each question's mark scheme and model answer)
- [ ] Delete exam papers and edit extracted questions

## Phase 3: home feed and habit

- [x] Weakness-weighted infinite feed of studied material, with recaps
- [x] Streaks, XP, daily goal, Today card with a seven-day chart
- [x] Daily reminder notification in the desktop app (time set in Settings)
- [x] Session summaries after Teach and drills

## Known limits

- `units.listForProject` reads whole source rows, including up to 450 KB of
  extracted text each. Fine for a semester module (tens of sources); moving
  text into its own table would remove the limit.
- Past streak days are judged against the current daily goal, so raising the
  goal can shorten an existing streak.

## Phase 4: chat

- [x] Agent controls already sit behind Options; access is chosen in the model picker
- [x] Interactive blocks in chat, follow-up chips, and Quiz me
- [x] Save chat quizzes into a unit's question bank
- [ ] Citations for every source type

## Phase 5: polish and redesign

- [x] Redesign starting from the Teach screen: progress bar, path outline, session XP, Finish for now
- [ ] Carry the redesign to Practice, the Library, and Home
- [x] Podcasts can cover one unit or the whole module
- [x] Notifications for practice questions, exam papers, and marking; retired lesson pipeline rows removed

## Phase 6: mobile and sync

- [ ] Hosted Convex option, offline cache, React Native on new contracts
