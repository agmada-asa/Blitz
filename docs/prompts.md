# Prompts

Every instruction Blitz sends to a model, in one place. Prompt text lives next
to the code that parses the reply, so each output format and its validator
change together; this page is the map.

## Shared rules

| Rules | Where | Used by |
| --- | --- | --- |
| Teaching voice for lessons, questions, and tutor replies | `lib/teaching-voice.ts` | Teach, practice questions, chat, podcasts, project agents |
| Interactive blocks: quiz (choice, cloze, ordering, matching, code output), steps, viz, graph, followups | `INTERACTIVE_BLOCKS_PROMPT` in `lib/interactive-blocks.ts`; see [interactive blocks](interactive-blocks.md) | Teach, chat |
| Citation links to supplied passages | `citationPrompt` in `lib/citations.ts` | Teach, chat |

Prompts that carry learner material mark it as untrusted reference text,
never instructions. Most fence it between explicit `BEGIN`/`END` markers;
podcast scripts use `SOURCE:` lines and `<source>` tags, and narration
`<source_sections>`.

## Learner-facing prompts

| Surface | Builder | Output and validation |
| --- | --- | --- |
| Teach a unit | `buildTeachPrompt` and `TEACH_RULES` in `lib/teach.ts`, assembled per turn by `teachTurnPrompt` in `lib/server/chat-turn/teach.ts` | Markdown lesson with ```outline and ```section markers (`parseTeachOutline`, `parseTeachSectionMarker`) and interactive blocks (`findQuizBlocks`) |
| Update a lesson | `buildTeachUpdatePrompt` in `lib/teach-update-prompt.ts` | JSON section changes checked before the merge; see [lesson updates](lesson-updates.md) |
| Past papers, mock exams, marking | `buildPastPaperPrompt`, `buildMockExamPrompt`, `buildExamGradingPrompt` in `lib/exam.ts` | JSON papers and marks; see [exam mode](exam-mode.md#prompts-and-validation) |
| Practice questions and recaps | `buildQuestionBankPrompt` in `lib/practice.ts` | JSON `{recaps, questions}` checked by `parseQuestionBank` with the lesson quiz rules |
| Chat | `buildWorkspaceChatPrompt` in `lib/server/workspace-chat.ts` | Markdown with citations and interactive blocks |
| Chat titles | `buildChatTitlePrompt` in `lib/server/chat-title.ts` | One short title, bounded and cleaned |
| Research proposals | `buildResearchProposalPrompt` in `lib/server/research-proposal.ts` | JSON proposal validated before review |
| Podcasts | `createPodcastScript` in `lib/server/podcast-script.ts` | JSON dialogue turns, word-count and note checks |
| Narration | `createAudiobookScript` in `lib/server/audiobook-script.ts` | JSON narration sections |

## Agent instructions

| Instructions | Where |
| --- | --- |
| Project folder rules for chat agents and Teach workspaces | `projectAgentInstructions` in `lib/server/project-agent.ts` |
| Provider execution and sandbox notes | `providerExecutionInstructions` in `lib/provider-execution.ts` |
| Approval and question requests shown in the composer | `lib/server/agent-request.ts` |
| Codex runtime notes | `codexRuntimeInstructions` in `lib/server/providers/codex-runtime.ts` |
| ACP turn wrapper (OpenCode, Antigravity) | `acpPrompt` in `lib/server/providers/acp-providers.ts` |
| Continuing a stopped reply | `workspaceChatContinuationPrompt` in `lib/server/workspace-chat.ts` |
| Rebuilding a chat in a new session | `replayedChatPrompt` in `lib/server/chat-turn/replay.ts` |
| Moving a chat to another provider | `handoffPrompt` in `lib/server/provider-handoff.ts` |
| Spoken replies in voice mode | `spokenPrompt` in `lib/server/chat-turn/settings.ts` |

## Changing a prompt

1. Change the builder and its parser together, and keep the format described
   in the prompt identical to what the parser accepts.
2. Update the tests next to it (`tests/teach.test.ts`, `tests/teach-updates.test.ts`,
   `tests/practice.test.ts`, `tests/exam.test.ts`, `tests/interactive-blocks.test.ts`,
   `tests/workspace-chat.test.ts`).
3. Check a real reply: `node --experimental-strip-types scripts/benchmark-teach.ts <folder> --teach` for Teach,
   or write a question batch from the Practice screen.
