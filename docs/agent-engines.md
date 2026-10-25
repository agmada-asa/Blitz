# Providers through agent-engines

Blitz runs Codex, Claude Code and OpenCode through [agent-engines](https://www.npmjs.com/package/agent-engines), a shared library that puts `codex app-server`, the Claude Agent SDK and ACP agents behind one thread, turn, and event API. The library owns the runtime mechanics: starting and resuming threads, streaming, approvals and questions, interrupts, process lifetime, the pinned Codex protocol, and version gates. Blitz owns the policy around them. OpenCode runs on the library's ACP engine (`opencode acp`), so all three providers share one event path.

## Where things live

| File | Owns |
| --- | --- |
| `lib/server/providers/engines.ts` | Creates each engine on the configured executable (`BLITZ_CODEX_COMMAND`, `BLITZ_CLAUDE_CODE_COMMAND`, or `codex` and `claude` on `PATH`), and maps availability and model catalogues into Blitz's provider shapes. |
| `lib/server/providers/run-text-turn.ts` | Turns Blitz's access settings into each runtime's thread options, checks a Codex selection against its catalogue, and checks OpenCode's install before its turn. |
| `lib/server/providers/opencode.ts` | Creates OpenCode's ACP engine with the turn's permission environment (`opencode-policy.ts`), maps access onto the engine's levels, and puts application instructions ahead of the prompt, since ACP has no instruction channel. |
| `lib/server/providers/engine-turn.ts` | Runs one turn on an engine: deadline, cancellation, output bounds, which text is the reply and which is thought, failure copy, and cleanup. |
| `lib/server/agent-request.ts` | Turns a runtime's approval, question, or elicitation into a composer interaction, and the learner's reply back into the runtime's answer. |
| `lib/server/chat-agent.ts` | Shows requests in the chat composer one at a time, and supplies the chat agent's Codex policy and Blitz's own question and checkpoint tools. |
| `lib/provider-activity.ts` | Turns tool, tool progress, and file events into the bounded steps shown beside a reply. A running tool's progress message (Codex MCP tools) replaces its detail until it ends. |

## Lifetime

Every turn, availability check, and catalogue read creates its own engine and closes it afterwards, so no Codex app-server, Claude Code or OpenCode process outlives the request that started it. A chat keeps its runtime thread ID and resumes it on the next message.

## Sign-in

Both engines run on the sign-in already on the Mac. Blitz allows an API key as well as a subscription (`requireSubscription: false`), since the learner chooses how each runtime is signed in. The settings page's connect and disconnect buttons run the CLIs' own login commands (`lib/server/providers/auth.ts`); the library only reports sign-in state.

## Access

Blitz never sets the library's neutral `access` level or `mode` on Codex threads, and on Claude Code threads uses only `full`, `ask`, and `read-only`; the `auto` and `accept-edits` levels and plan mode are unused, so every approval still reaches the learner.

Codex threads get an explicit approval policy and sandbox on start and resume. Workspace-write threads also set `sandbox_workspace_write` so writes stay in the workspace, with no network and no shared temporary directories. The chat agent sends `approvalsReviewer: "user"` so approvals always reach the learner.

Claude Code background turns load no settings, skills, plugins, hooks, MCP servers, or tools. Chat turns load the learner's user-level Claude Code setup with hooks off (and the SDK's hook lifecycle events off, which the library otherwise turns on), and map access onto permission modes: full access bypasses prompts, approval mode routes them to Blitz, and read-only or no-approval modes refuse anything that would need one. Claude approvals are always once only; Blitz never writes a permission rule to Claude's settings.

OpenCode turns get their permissions from the environment Blitz starts OpenCode with: a dedicated `blitz-turn` agent, redefined on every turn with that turn's rules, and project config off. On top of that the engine's access level answers what OpenCode still asks: `full` for full access, `read-only` for background, read-only and no-approval turns, and `ask` for approval mode, which reaches the learner like any other approval. An approval is only reviewed when it offers an allow-once choice. The agent name stays the same across turns because OpenCode refuses to prompt a reloaded session whose agent no longer exists; sessions saved under the per-turn names Blitz used before fail to resume, and the chat replays their history into a new session. Engine turns hold back `turn-started` on a resumed OpenCode session until OpenCode answers (`confirmResume`), so a rejected resume reaches the chat as a transport failure it can replay.

## Replies

Only text, reasoning, tool, file, request, and lifecycle events shape a turn. Every other event the library sends (hooks, notices, goals, MCP status, realtime, prompt suggestions, and any added in a later minor release) is ignored, and a failed turn whose error kind Blitz does not map, such as `limit`, gets the generic failure copy.

A Codex reply is its answer messages; progress notes between tool calls and reasoning become the thought trace. A Claude Code or OpenCode reply is everything it streamed in the turn. Subagent text stays out of both, though subagent tool steps still show.

## Checks

The library refuses a runtime below its floor when a thread starts: Codex CLI 0.164.0 (within v0) and Claude Code 2.1.248 as of agent-engines 0.4.0. Its own weekly check watches the latest Codex and Claude Code. `npm run check:runtimes` covers the rest: OpenCode's version, and the live Codex catalogue against `CODEX_MODEL_OPTIONS`. Tests use an in-memory engine (`tests/fixtures/fake-engine.ts`) and never start a model turn. It models only the methods Blitz calls; the rest of the engine and thread surface throws `UnsupportedFeatureError`.
