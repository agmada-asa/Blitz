# Project area overhaul

These screens are a static proposal in `/preview/project-overhaul`. Every number, title, answer, source excerpt, and progress state in the preview is illustrative. The preview reads no project data and changes no project records.

## Decisions from review

- Open a project on an overview with one next action, **Resume learning**.
- Group related work under **Learn**, **Practice**, **Sources**, and **Listen**. Keep **Chat** available from the project and the item being studied.
- Keep the current Blitz visual language, including its semantic colors, typography, and shared UI controls.
- Retire the older `/study` deck. Its empty state should not appear beside a populated project. Preserve existing URLs deliberately when implementation begins.
- Keep the app sidebar visible throughout Practice. The Practice hub offers Questions (feedback after each answer), Test (results at the end), and Write (compare with sources).
- Open a Learn section or concept directly into its lesson. The Learning path control remains available inside the lesson.
- Put Deep Research beside Upload, Paste, and Link in a compact Add sources tab strip. Keep its request and suggested source review inline, use shadcn controls, and offer a file drop zone alongside the upload button.
- Put recording creation in a modal opened from the Listen header and show recordings as square cards. Show projects as compact tiles in the project list.

## Screen coverage

| Audited screens                                           | Proposed mockup location                            | Change to review                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1, 18: project workspace on desktop and mobile            | Project / Overview                                  | A clear resume target and visible destinations replace the three competing columns.                   |
| 19: mobile tools                                          | Project / Overview                                  | Sources, Listen, Practice, and Chat are reached directly instead of through a duplicate tools dialog. |
| 21: mobile sections                                       | Learn / Learning path                               | Sections and concepts show progress and the next lesson.                                              |
| 23, 24: project actions and rename                        | Project / Project actions and rename                | Keep the actions together, with a named delete confirmation.                                          |
| 2, 3, 4, 22: source manager, paste, link, mobile overflow | Sources / Add source variants                       | Each entry method has a full-width destination that fits narrow screens.                              |
| 5, 6, 7: source PDF, overview, extracted text             | Sources / Source detail variants                    | Original, summary, and extracted text live under one source.                                          |
| 8: Find sources                                           | Sources / Find sources and suggestions              | Research becomes an add-source method with a review step.                                             |
| 9: audio library and creation                             | Listen / Library and creation variants              | A header button opens recording creation; finished recordings appear as square cards.                 |
| 10, 27: listening room and mobile transcript              | Listen / Listening room                             | Timed passages make the transcript navigable.                                                         |
| 11: ask about audio                                       | Listen / Ask about audio                            | Passage context travels to one chat pattern.                                                          |
| 12, 25: practice                                          | Practice / Practice question and feedback           | Project context and immediate feedback are explicit.                                                  |
| 13: test                                                  | Practice / Test setup, question, and results        | Test has its own start and end, with results saved until completion.                                  |
| 14, 26: written answers                                   | Practice / Written answer and comparison            | Prompt position and source guidance become clear.                                                     |
| 15: older Study feed                                      | Retired                                             | Do not show an empty second deck for a populated project.                                             |
| 16, 17, 28: project, card, and mobile chat                | Chat / Project chat, lesson question, source answer | One context summary, a clear return path, and a composer that fits mobile.                            |
| 20, 29: deep dive and longer explanation                  | Learn / More detail and check feedback              | One expanded explanation and one contextual Ask action replace overlapping depth controls.            |

## Live implementation

The project route now opens an overview with the next learning item, real concept progress, a back link to the project list, and boxed links to Learn, Practice, Sources, and Listen. **Resume learning** opens the saved lesson directly. **Ask Blitz** opens project chat; lesson questions open chat with the current card attached.

| Area     | Live route                                                           | Existing behavior retained                                                                                                      |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Learn    | `/projects/[projectId]/learn`                                        | Learning path, exposure tracking, server-scored checks, saved position, and source references.                                  |
| Practice | `/projects/[projectId]/practice`                                     | Immediate-feedback questions, end-of-test results, written drafts, and source comparisons. The old `/study` URL redirects here. |
| Sources  | `/projects/[projectId]/sources` and `/sources/[sourceId]` beneath it | Upload, paste, link, research, processing and retry, source previews, downloads, and generated artifact actions.                |
| Listen   | `/projects/[projectId]/listen` and `/listen/[audioId]` beneath it    | Recording creation, status, playback, downloads, transcript passages, and contextual questions.                                 |
| Chat     | `/chat` with project or card context                                 | Existing messages, attachments, streaming, and agent controls, with a compact context row and composer.                         |

The Sources page lists **Your sources** and **Created files** in aligned columns, with file browser actions in the desktop app. Paste uses **Import notes**. Practice includes a back link to its project. Learn has Previous and Next controls above each lesson card. The live routes use real project data and existing API boundaries. The preview remains a static set of fixtures for design review. Listening transcripts have timestamps and speakers but no chapter metadata, so the room uses timed passages without invented chapter titles.
