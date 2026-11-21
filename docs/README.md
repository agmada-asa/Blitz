# Blitz docs

How Blitz works, for anyone changing it. Start with [architecture](architecture.md). The [README](../README.md) covers installing and running it.

## Running Blitz

- [Architecture](architecture.md): processes, the background worker, code layout and data model
- [Local server and updates](local-server.md): the background server, releases and how an update works
- [Local desktop host](local-desktop-host.md): the desktop app, ports, project folders and project agents
- [Providers through agent-engines](agent-engines.md): how Codex, Claude Code, OpenCode and Antigravity are run
- [Provider text turns](provider-turns.md): one model turn, working folders and streamed replies
- [AI model settings](ai-model-settings.md): which model each task uses, and spending limits
- [MCP server](../mcp/README.md): letting other agents read and add material

## Material

- [Adding material](source-import.md): files, notes, links and the Sources page
- [Source extraction](source-extraction.md): formats, limits and how originals are shown
- [Source ingestion](source-ingestion.md): normalizing, passages and public URL fetching
- [Find sources](research.md): research proposals and approved imports
- [Generation evals](generation-evals.md): measuring what extraction keeps

## Teaching

- [Teach](teach.md): live lessons, the Teach screen, side chat and long sessions
- [Lesson updates](lesson-updates.md): teaching new files in a unit already taught
- [Interactive blocks](interactive-blocks.md): quizzes, worked steps, graphs and visualisations in replies
- [Prompts](prompts.md): every prompt and where its parser lives

## Practice

- [Practice, the feed and progress](practice.md): question banks, drills, Review, XP and streaks
- [Study and test sessions](study-sessions.md)
- [Written practice](written-practice.md)
- [Exam mode](exam-mode.md): past papers, mock exams and marking
- [Learning core](learning-core.md): scoring answers and scheduling reviews
- [Learning HTTP API](learning-api.md)

## Chat

- [Workspace chat](workspace-chat.md): context, access, requests, branching and handoff
- [Chat citations](chat-citations.md): how a citation finds and shows its passage
- [Markdown display](markdown.md): maths, diagrams and safe rendering
- [Notifications](notifications.md)

## Audio

- [Voice](voice.md): dictation, voice mode and phone access
- [Local speech](local-kokoro.md): Kokoro and Whisper setup and workers
- [Podcasts and audiobooks](project-audio.md)
