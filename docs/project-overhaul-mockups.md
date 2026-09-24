# Project area mockup plan

These screens are a static proposal in `/preview/project-overhaul`. Every number, title, answer, source excerpt, and progress state in the preview is illustrative. The preview reads no project data and changes no project records.

## Decisions from review

- Open a project on an overview with one next action, **Resume learning**.
- Group related work under **Learn**, **Practice**, **Sources**, and **Listen**. Keep **Chat** available from the project and the item being studied.
- Keep the current Blitz visual language, including its semantic colors, typography, and shared UI controls.
- Retire the older `/study` deck. Its empty state should not appear beside a populated project. Preserve existing URLs deliberately when implementation begins.

## Screen coverage

| Audited screens | Proposed mockup location | Change to review |
| --- | --- | --- |
| 1, 18: project workspace on desktop and mobile | Project / Overview | A clear resume target and visible destinations replace the three competing columns. |
| 19: mobile tools | Project / Overview | Sources, Listen, Practice, and Chat are reached directly instead of through a duplicate tools dialog. |
| 21: mobile sections | Learn / Learning path | Sections and concepts show progress and the next lesson. |
| 23, 24: project actions and rename | Project / Project actions and rename | Keep the actions together, with a named delete confirmation. |
| 2, 3, 4, 22: source manager, paste, link, mobile overflow | Sources / Add source variants | Each entry method has a full-width destination that fits narrow screens. |
| 5, 6, 7: source PDF, overview, extracted text | Sources / Source detail variants | Original, summary, and extracted text live under one source. |
| 8: Find sources | Sources / Find sources and suggestions | Research becomes an add-source method with a review step. |
| 9: audio library and creation | Listen / Library and creation variants | Recording choice moves out of a header dialog. |
| 10, 27: listening room and mobile transcript | Listen / Listening room | Chapters and landmarks break up the long transcript. |
| 11: ask about audio | Listen / Ask about audio | Passage context travels to one chat pattern. |
| 12, 25: practice | Practice / Practice question and feedback | Project context and immediate feedback are explicit. |
| 13: test | Practice / Test setup, question, and results | Test has its own start and end, with results saved until completion. |
| 14, 26: written answers | Practice / Written answer and comparison | Prompt position and source guidance become clear. |
| 15: older Study feed | Retired | Do not show an empty second deck for a populated project. |
| 16, 17, 28: project, card, and mobile chat | Chat / Project chat, lesson question, source answer | One context summary, a clear return path, and a composer that fits mobile. |
| 20, 29: deep dive and longer explanation | Learn / More detail and check feedback | One expanded explanation and one contextual Ask action replace overlapping depth controls. |

## Implementation questions after the mockup review

1. Which project overview information deserves the most space once it uses real data?
2. Should Chat be a visible project destination, an action within each area, or both?
3. For existing `/study` links, should implementation redirect to Practice or show a short explanation first?

No live routes, persistence, source processing, scoring, generation, or chat behavior are part of this branch.
