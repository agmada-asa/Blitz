# Interactive blocks

Tutor and chat replies embed quizzes, worked examples, graphs, visualisations and follow-up questions as fenced code blocks. `lib/interactive-blocks.ts` defines the protocol once, for the prompt, the server and the renderer: it parses and validates fences, finds quizzes in saved replies for scoring, summarises blocks for read-aloud, and builds the sandboxed visualisation document. It has no React or browser dependencies, so routes and Node tests use it directly.

| Fence | What it shows | Renderer |
| --- | --- | --- |
| `quiz` | One question: single choice, multiple answer, true/false, cloze, ordering, matching or code output | `quiz-block.tsx` |
| `steps` | A worked example revealed one step at a time (1–12 steps) | `steps-block.tsx` |
| `graph` | Functions and data on axes, with optional sliders | `graph-block.tsx` |
| `viz` | A self-contained HTML visualisation | `viz-block.tsx` |
| `followups` | Up to three suggested next questions | `followups-block.tsx` |

Renderers live in `components/ui/interactive-blocks/`. Mermaid diagrams are ordinary Markdown fences; see [Markdown display](markdown.md).

## Prompting

`INTERACTIVE_BLOCKS_PROMPT` describes every format with an example and its limits. Teach always includes it. Its rules require one or two quizzes in each section, at least one applying the idea to a new case, with question types varied across the lesson. They also ask for a visual wherever the idea has a shape and a steps block only for a trace through three or more dependent steps. Follow-ups appear only when the section leaves questions open. Each block type's guidance says when not to use it as well as when to: a mermaid diagram needs branching or several stages, and data is shown as a code block. Ordinary chat adds `CHAT_INTERACTIVE_BLOCKS_GUIDANCE`, which asks for blocks whenever the learner is learning something and not in greetings, short factual answers or project tasks.

## Validation

`parseInteractiveBlock` validates a fence against `INTERACTIVE_BLOCK_LIMITS`. Some of the limits: quiz IDs of letters, digits, `_` or `-`; 2–6 choice options; 3–8 ordering items; 3–6 matching pairs with up to 2 extras; up to 6 cloze blanks; step bodies up to 4,000 characters; up to 6 graph series, 4 sliders and 500 points per series. A block that fails validation is shown as its source code, and a fence still streaming waits until it closes.

Ordering and matching options are shuffled with `stableShuffle`, seeded from the block, so the browser and server always agree on the order shown.

## Quizzes and scoring

A quiz's answer key is in the reply, but the learner's answer is scored on the server. Teach answers go to `POST /api/teach/answer`, which finds the quiz in the saved reply with `findQuizBlocks`, saves it as a learning item and records the answer; see [learning core](learning-core.md#scoring-an-answer). The browser grades with `gradeQuizAnswer` for immediate feedback, using the same rules through `structuredQuestion`. A chat quiz can be saved to a unit's question bank with **Save to practice** (see [practice](practice.md#saving-chat-quizzes)).

## Graphs

Graph expressions are never run as JavaScript. `lib/graph-expression.ts` parses them into a small syntax tree supporting numbers, `+ - * / ^`, brackets, `pi`, `e`, a fixed list of maths functions, `x` and declared slider names, and evaluates the tree itself. `lib/graph-plot.ts` samples curves, fits the y range and picks axis ticks, so the maths can be tested without a browser.

## Visualisations

A `viz` block is raw HTML (up to 60,000 characters) run in a sandboxed iframe built by `buildVizDocument`. Its content security policy (`VIZ_CONTENT_SECURITY_POLICY`) allows inline scripts and styles and `data:`/`blob:` images only, so it can't load anything or make network requests. Theme colours are passed in as CSS variables and updated by message when the theme changes, and the frame reports its height so it sizes to its content. A script can still navigate its own frame, so treat source-driven prompt injection as possible, though it can't reach Blitz data.
