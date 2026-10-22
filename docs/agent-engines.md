# Codex and Claude Code through agent-engines

Blitz runs Codex and Claude Code through [agent-engines](https://www.npmjs.com/package/agent-engines), a shared library that puts `codex app-server` and the Claude Agent SDK behind one thread, turn, and event API. The library owns the runtime mechanics: starting and resuming threads, streaming, approvals and questions, interrupts, process lifetime, the pinned Codex protocol, and version gates. Blitz owns the policy around them. OpenCode stays on Blitz's own ACP adapter (`lib/server/providers/acp.ts`) until the library has an ACP engine.

## Where things live

| File | Owns |
| --- | --- |
| `lib/server/providers/engines.ts` | Creates each engine on the configured executable (`BLITZ_CODEX_COMMAND`, `BLITZ_CLAUDE_CODE_COMMAND`, or `codex` and `claude` on `PATH`), and maps availability and model catalogues into Blitz's provider shapes. |
| `lib/server/providers/run-text-turn.ts` | Turns Blitz's access settings into each runtime's thread options, checks a Codex selection against its catalogue, and routes OpenCode to ACP. |
| `lib/server/providers/engine-turn.ts` | Runs one turn on an engine: deadline, cancellation, output bounds, which text is the reply and which is thought, failure copy, and cleanup. |
| `lib/server/agent-request.ts` | Turns a runtime's approval, question, or elicitation into a composer interaction, and the learner's reply back into the runtime's answer. |
| `lib/server/chat-agent.ts` | Shows requests in the chat composer one at a time, and supplies the chat agent's Codex policy and Blitz's own question and checkpoint tools. |
| `lib/provider-activity.ts` | Turns tool, tool progress, and file events into the bounded steps shown beside a reply. A running tool's progress message (Codex MCP tools) replaces its detail until it ends. |

## Lifetime

Every turn, availability check, and catalogue read creates its own engine and closes it afterwards, so no Codex app-server or Claude Code process outlives the request that started it. A chat keeps its runtime thread ID and resumes it on the next message.

## Sign-in

Both engines run on the sign-in already on the Mac. Blitz allows an API key as well as a subscription (`requireSubscription: false`), since the learner chooses how each runtime is signed in. The settings page's connect and disconnect buttons run the CLIs' own login commands (`lib/server/providers/auth.ts`); the library only reports sign-in state.

## Access

Codex threads get an explicit approval policy and sandbox on start and resume. Workspace-write threads also set `sandbox_workspace_write` so writes stay in the workspace, with no network and no shared temporary directories. The chat agent sends `approvalsReviewer: "user"` so approvals always reach the learner.

Claude Code background turns load no settings, skills, plugins, hooks, MCP servers, or tools. Chat turns load the learner's user-level Claude Code setup with hooks off, and map access onto permission modes: full access bypasses prompts, approval mode routes them to Blitz, and read-only or no-approval modes refuse anything that would need one. Claude approvals are always once only; Blitz never writes a permission rule to Claude's settings.

## Replies

A Codex reply is its answer messages; progress notes between tool calls and reasoning become the thought trace. A Claude Code reply is everything it streamed in the turn. Subagent text stays out of both, though subagent tool steps still show.

## Checks

The library's own weekly check watches the latest Codex and Claude Code. `npm run check:runtimes` covers the rest: OpenCode's version, and the live Codex catalogue against `CODEX_MODEL_OPTIONS`. Tests use an in-memory engine (`tests/fixtures/fake-engine.ts`) and never start a model turn.
