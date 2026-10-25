# Codex and Claude Code through agent-engines

Blitz runs Codex and Claude Code through [agent-engines](https://www.npmjs.com/package/agent-engines), a shared library that puts `codex app-server` and the Claude Agent SDK behind one thread, turn, and event API. The library owns the runtime mechanics: starting and resuming threads, streaming, approvals and questions, interrupts, process lifetime, the pinned Codex protocol, and version gates. Blitz owns the policy around them. OpenCode stays on Blitz's own ACP adapter (`lib/server/providers/acp.ts`); the library's ACP engine is not used yet.

## Where things live

| File | Owns |
| --- | --- |
| `lib/server/providers/engines.ts` | Creates each engine on the configured executable (`BLITZ_CODEX_COMMAND`, `BLITZ_CLAUDE_CODE_COMMAND`, or `codex` and `claude` on `PATH`), and maps availability and model catalogues into Blitz's provider shapes. |
| `lib/server/providers/run-text-turn.ts` | Turns Blitz's access settings into each runtime's thread options, checks a Codex selection against its catalogue, and routes OpenCode to ACP. |
| `lib/server/providers/engine-turn.ts` | Runs one turn on an engine: deadline, cancellation, output bounds, which text is the reply and which is thought, failure copy, and cleanup. |
| `lib/server/agent-request.ts` | Turns a runtime's approval, question, or elicitation into a composer interaction, and the learner's reply back into the runtime's answer. |
| `lib/server/chat-agent.ts` | Shows requests in the chat composer one at a time, and supplies the chat agent's Codex policy and Blitz's own question and checkpoint tools. |
| `lib/provider-activity.ts` | Turns tool, tool progress, and file events into the bounded steps shown beside a reply. A running tool's progress message (Codex MCP tools) replaces its detail until it ends. |
| `lib/server/providers/engine-pool.ts` | Holds an engine prewarmed for a new Teach session's first turn until that turn claims it, closing it after three minutes otherwise. |
| `lib/provider-thread-features.ts` | Which providers fork, rewind, compact, report context usage, and prewarm: Codex and Claude Code; OpenCode none. |

## Lifetime

Every turn, availability check, and catalogue read creates its own engine and closes it afterwards, so no Codex app-server or Claude Code process outlives the request that started it. A chat keeps its runtime thread ID and resumes it on the next message.

The one exception is prewarm. Opening a new Teach session calls `POST /api/teach/prewarm`, which creates the reply provider's engine with the exact thread options the first turn will send (`lib/server/teach-turn-settings.ts`) and calls `engine.prewarm()`: Codex starts its app-server, and Claude Code also opens the new thread's process. The first turn claims the engine from the pool and owns it from then on. Only a new thread benefits, so a resumed session is not prewarmed. The saving has not been measured; compare with `npm run benchmark:teach -- --teach`.

## Sign-in

Both engines run on the sign-in already on the Mac. Blitz allows an API key as well as a subscription (`requireSubscription: false`), since the learner chooses how each runtime is signed in. The settings page's connect and disconnect buttons run the CLIs' own login commands (`lib/server/providers/auth.ts`); the library only reports sign-in state.

## Access

Blitz never sets the library's neutral `access` level or `mode` on Codex threads, and on Claude Code threads uses only `full`, `ask`, and `read-only`; the `auto` and `accept-edits` levels and plan mode are unused, so every approval still reaches the learner.

Codex threads get an explicit approval policy and sandbox on start and resume. Workspace-write threads also set `sandbox_workspace_write` so writes stay in the workspace, with no network and no shared temporary directories. The chat agent sends `approvalsReviewer: "user"` so approvals always reach the learner.

Claude Code background turns load no settings, skills, plugins, hooks, MCP servers, or tools. Chat turns load the learner's user-level Claude Code setup with hooks off (and the SDK's hook lifecycle events off, which the library otherwise turns on), and map access onto permission modes: full access bypasses prompts, approval mode routes them to Blitz, and read-only or no-approval modes refuse anything that would need one. Claude approvals are always once only; Blitz never writes a permission rule to Claude's settings.

## Replies

Only text, reasoning, tool, file, request, notice, compaction, and lifecycle events shape a turn. Of the notices, `refusal`, `permission-denied`, and `moderation` are saved on the reply and shown beside it; `warning`, `config`, `deprecation`, and `info` are logged on the server. Every other event the library sends (hooks, goals, MCP status, realtime, prompt suggestions, and any added in a later minor release) is ignored. A `context-window` failure says the conversation ran out of room, an `auth` one that the provider is signed out, and a failed turn whose error kind Blitz does not map, such as `limit`, gets the generic failure copy.

## Thread operations

Around a turn, `engine-turn.ts` can also:

- fork a saved thread through a turn instead of starting or resuming one (branched and edited chats); a failed fork throws before any turn, and the route replays instead;
- rewind before a turn, so a Teach reply is redone in place (Try that again); a failed rewind runs the turn on top of the conversation;
- compact before the turn, sending a different prompt only when compaction ran;
- read context usage after a completed turn, for the Teach context meter.

`runEngineCompaction` compacts a saved thread outside any turn (Compact now). Turn IDs saved under agent-engines 0.2.0 may not match what `forkThread` and `rewind` take on Claude Code; both fall back as above.

A Codex reply is its answer messages; progress notes between tool calls and reasoning become the thought trace. A Claude Code reply is everything it streamed in the turn. Subagent text stays out of both, though subagent tool steps still show.

## Checks

The library refuses a runtime below its floor when a thread starts: Codex CLI 0.164.0 (within v0) and Claude Code 2.1.248 as of agent-engines 0.4.0. Its own weekly check watches the latest Codex and Claude Code. `npm run check:runtimes` covers the rest: OpenCode's version, and the live Codex catalogue against `CODEX_MODEL_OPTIONS`. Tests use an in-memory engine (`tests/fixtures/fake-engine.ts`) and never start a model turn. It models only the methods Blitz calls; the rest of the engine and thread surface throws `UnsupportedFeatureError`.
