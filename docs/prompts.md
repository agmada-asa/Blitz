# Prompts

Every instruction Blitz sends to a model, in one place. Prompt text lives next
to the code that parses the reply, so each output format and its validator
change together; this page is the map.

## Shared rules

| Rules | Where | Used by |
| --- | --- | --- |
| Teaching voice for lessons, questions, and tutor replies | `lib/teaching-voice.ts` | Teach, practice questions, chat, podcasts |
| Interactive blocks: quiz (choice, cloze, ordering, matching, code output), steps, viz, followups | `INTERACTIVE_BLOCKS_PROMPT` in `lib/interactive-blocks.ts` | Teach, chat |
| Citation links to supplied passages | `citationPrompt` in `lib/citations.ts` | Teach, chat |

Every prompt that carries learner material fences it between explicit
`BEGIN`/`END` markers and says it is untrusted reference text, never
instructions.

## Learner-facing prompts

| Surface | Builder | Output and validation |
| --- | --- | --- |
| Teach a unit | `buildTeachPrompt` and `TEACH_RULES` in `lib/teach.ts` | Markdown lesson with ```outline and ```section markers (`parseTeachOutline`, `parseTeachSectionMarker`) and interactive blocks (`findQuizBlocks`) |
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

## Changing a prompt

1. Change the builder and its parser together, and keep the format described
   in the prompt identical to what the parser accepts.
2. Update the tests next to it (`tests/teach.test.ts`, `tests/practice.test.ts`,
   `tests/interactive-blocks.test.ts`, `tests/workspace-chat.test.ts`).
3. Check a real reply: `npm run benchmark:teach -- <folder> --teach` for Teach,
   or write a question batch from the Practice screen.
