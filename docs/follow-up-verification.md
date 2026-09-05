# Follow-up verification, 5 September 2026

The morning fixes add an Activity route, background notices, saved-chat links,
research stages and elapsed time, recoverable large imports, and answer colors.
The fullscreen feed retains floating Library and Activity controls. Android
still opens Library in the browser; a native Library is outstanding.

## Checks

- Root: 89 tests, TypeScript, ESLint, and production build passed.
- Browser: inspected at 390 × 844 and 1280 × 900. Activity had no horizontal
  overflow. Feed, Study, and finished tests showed green correct options and
  red selected mistakes. Tests withheld answer keys until Finish.
- Browser checks used clearly labeled route fixtures for answer submissions;
  no real learner answers or new chat messages were submitted. Reopening an
  existing saved chat, research preparation states, and background notices
  were inspected. Browser route fixtures were removed afterward.
- A synthetic 160-page selectable PDF exceeded the old 120,000-character
  ceiling, extracted successfully, and split with exact body reconstruction.
  The user's original Atomic Habits PDF was not attached, only its error log.
  Its rejected upload must be selected again.
- Source mutation tests cover atomic queue creation, duplicate upload reuse,
  and preservation of a failed job's checkpoint on retry. Research tests
  cover multipart lease retention, replay, and changed-source rejection.

## Live recovery

Worker updates were loaded only after the active queue drained. The existing
research jobs were then retried without resetting their saved sections.
Synth School finished with 77 items, Sound Synthesis with 68, and Subtractive
Synthesis with 38. Wavetable Oscillators advanced to 54 items and five completed
sections of nine, then stopped after invalid model output and one repair.
Its progress remains saved and its project offers Retry. Read-only review found
no deterministic prompt/validator contradiction; raw failed output was ephemeral.

The previously oversized Live Instrument Reference downloaded in three parts.
Its preparation remains active at handoff. The Learning Synths interactive
website returned browser compatibility text and produced no study content.
It was not retried automatically.

Elapsed times measure time already spent, including queue time and retries.
They are not completion estimates. Browser extraction and uploading require
keeping the page open until parts are saved; queued preparation runs on the
awake Mac after navigation or closing the page.
