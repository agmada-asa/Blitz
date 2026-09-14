# Provider integration audit

This document records the integration changes made on September 9, 2026. Blitz connects to local Codex and Claude Code runtimes and to OpenCode and Antigravity through ACP. It does not connect directly to the ChatGPT desktop application's complete hosted tool environment.

## Root causes

The common request type accepted sandbox and model settings that individual adapters did not consistently apply. Codex's shared text runner dropped the sandbox argument and its transport hardcoded read-only access. Workspace chat compensated with a separate transport override, so the same provider behaved differently depending on its caller.

Approval handling reduced native decisions to a boolean. ACP option IDs and scopes disappeared before reaching the chat UI. Reverse requests were rejected before the application could answer them. In particular, Antigravity asks questions through `session/request_permission` with an `interaction_` tool-call ID. Treating every permission callback as an approval obscured those questions.

The conversation stored only one active request. Cleanup deleted that record, losing the question, available choices, and answer. HTTP disconnection also cancelled provider execution, so a browser reload could destroy a pending interaction.

Uploads followed the study-source pipeline. Files required a project and became extracted text before reaching the provider. There was no native image content contract. A later live test also caught the distinction between Codex app-server's image `url` field and the public API's `image_url` field, which the initial mock tests had not enforced.

The provider catalog conflated JSON validation with native structured output, workspace writing with sandbox support, and an adapter's transport support with a particular model's capabilities. Unsupported reasoning settings could be silently normalized. Failure to load valid saved settings could also fall back to another provider.

## Boundaries after the changes

| Layer | Responsibility |
| --- | --- |
| `lib/provider-capabilities.ts` | Shared adapter features and accurate access descriptions for the UI and server. Conditional ACP capabilities remain explicit. |
| `lib/provider-execution.ts` | Effective filesystem, command, network, tool, and approval facts. Tool denial is distinct from an OS sandbox. |
| `lib/server/providers/` | Native protocol translation, model configuration, process lifecycle, image content, and reverse-request responses. |
| `lib/server/agent-request.ts` and `lib/agent-request.ts` | Bounded typed questions, forms, approval choices, answer validation, and safe parsing of persisted controls. |
| `lib/server/chat-agent.ts` | Serializes reviews, persists native request correlation, waits for decisions, and returns adapter-specific responses. |
| `convex/chatAgents.ts` | Atomic request decisions and durable interaction history. Wrong-chat, wrong-message, duplicate, expired, and stale decisions are rejected. |
| `lib/provider-activity.ts` | Bounded native tool lifecycle events, correlated by provider IDs and rendered from persisted history. |
| `lib/server/chat-run-registry.ts` | Keeps live runs addressable after browser reload and supports explicit pause of an exact chat/message pair. |
| Chat composer and message components | File/drop/clipboard intake, Markdown, attachment previews, structured controls, and completed interaction presentation. |

## Permissions and provider behavior

Codex receives explicit sandbox policy on thread creation, resume, and turn start. Workspace-write roots and disabled command networking are reasserted on each turn. Full access removes that sandbox; it does not override project instructions. Native developer instructions carry the effective execution description. `untrusted` means that commands outside the trusted set need user approval, not that an application reviewer approves automatically.

Claude Code receives application instructions through its native system-prompt append option. Images use base64 blocks through stream-json input. Its existing tool policies remain distinct from OS isolation. The supported tool set is explicit; hooks and external MCP configuration remain disabled by the adapter. `AskUserQuestion` uses structured question controls and returns answers through the native `updatedInput` response.

ACP keeps client filesystem and terminal capabilities false because Blitz does not implement those client RPC services. These capability flags must not be presented as proof that the provider process is sandboxed. Native permission requests preserve option IDs, including provider-offered persistent choices, and decisions are validated against the active session and advertised options. Denied/background policies cannot route around their restrictions through the generic reverse-request handler.

ACP model and mode selection inspect advertised session configuration. Native images require `promptCapabilities.image`. Since ACP v1 does not expose a developer message role, bounded application instructions are carried in a separate, clearly identified text context. Unknown reverse methods and unimplemented ACP form/URL elicitation are rejected explicitly. T3’s internal `session/elicitation` handler name is not treated as a stable wire method. OpenCode's question tool remains unavailable through this adapter; its native permission UI remains supported.

Antigravity `interaction_` permission requests become single-select questions with native option IDs. Cancellation returns a native cancelled outcome. Antigravity does not provide the tool-free background mode that Blitz requires for source generation; the task picker continues to exclude it from that task.

Codex model discovery now reads the authenticated runtime `model/list` catalog, including input modalities and native reasoning levels such as `none` and `minimal`. A short-lived catalog cache supports both the picker and dispatch validation, including chat's custom approval transport. Unsupported models, image inputs, and reasoning levels fail before a native turn begins. Catalog lookup failures do not silently substitute another model.

## Attachments and conversation continuity

Projectless uploads receive opaque draft ownership tokens and server-controlled storage paths. Sending binds an upload to its chat. Replays and branches preserve document identity and image MIME metadata while enforcing ownership. Branches clone document records and reuse the immutable stored original rather than transferring ownership away from the original chat.

PNG, JPEG, WebP, and GIF inputs are bounded and checked against their signatures before model delivery. Individual native images are limited to 5 MB and a turn's image bytes to 20 MB. Codex and ACP have separate 30 MB bounded outbound prompt allowances for base64 payloads; incoming protocol lines remain independently bounded (30 MB for Codex because user-message events can echo images; 1 MB for ACP). PDF, PowerPoint, Markdown, and text documents continue to use extracted text context. The interface does not claim that those formats are native binary model inputs.

File selection, multiple-file drops, and clipboard images share intake rules. Ordinary text paste retains Markdown, code, and list formatting. User and assistant messages use the same safe Markdown renderer, including links, code blocks, tables, and supported remote images. Completed native requests retain human-readable questions and decisions rather than becoming assistant Markdown.

## Reference implementation and protocol evidence

The comparison used pinned [T3 Code v0.0.39 AntigravityDriver](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/Drivers/AntigravityDriver.ts), [AntigravityAdapter](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/Layers/AntigravityAdapter.ts), [AntigravityProtocol](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/acp/AntigravityProtocol.ts), and [AcpSessionRuntime](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/acp/AcpSessionRuntime.ts). These are behavioral references; the changes do not copy T3's runtime implementation.

T3 keeps a thread-scoped ACP runtime, registers bounded client filesystem handlers, isolates Antigravity account profiles, and separates initialization health checks from authenticated catalog discovery. Blitz retains its bounded per-turn subprocess architecture with native resume/replay. Adding a persistent provider daemon, filesystem RPC service, or isolated account-profile manager would be separate architectural work. The implementation adopts native request correlation, cancellation, question detection, capability checks, and exact permission choices without claiming those larger services already exist.

The Codex wire shape was checked against `codex-cli 0.153.4` using `codex app-server generate-ts`, and against the [official app-server documentation](https://learn.chatgpt.com/docs/app-server). ACP behavior was checked against the [ACP schema](https://agentclientprotocol.com/protocol/v1/schema). Tests use in-memory provider processes and real Convex handlers so most verification does not invoke a paid model or execute a real privileged action.

## Verification and limits

The baseline had 259 passing tests and passed typecheck. Added coverage exercises sandbox propagation, settings validation, native images, ACP negotiation and cancellation, exact permission choices, Antigravity and Claude questions, duplicate/stale decisions, secret-response redaction, persisted history, projectless ownership and branching, clipboard/drop intake, and incomplete Markdown prefixes.

Final automated verification: 311 tests pass, TypeScript passes, and the production build passes. ESLint has no errors and one advisory warning about native Markdown `<img>` rendering; these images retain their intrinsic dimensions and load without a remote optimization proxy.

Live browser checks used synthetic data at desktop and narrow mobile widths. A native Codex question was answered, reloaded in its completed state, and a second pending question survived reload before answering and model continuation. Clipboard image upload reached native Codex in an existing session and the model correctly described a valid blue square. A synthetic approval checkpoint exercised denial and continued execution without performing an external action.

Claude and ACP behavior is covered by protocol fixtures and real Convex request-handler tests; these checks do not establish authenticated live compatibility with every installed provider/version or optional extension. Drag/drop and clipboard intake have pure-function regression coverage plus manual clipboard verification; there is no standalone automated browser test runner in this repository.

Persisted interaction history survives a server restart, but an in-flight native JSON-RPC request cannot be resurrected after its provider process has died. Such requests need a terminal interrupted/expired state and an explicit retry. Browser reload within the running local server is a different case and must keep the active provider request alive. The run registry is process-local, so multi-instance deployments need a shared worker/session owner before supporting cross-instance pause or recovery.

No production deployment or provider-account changes are part of this work. The adapters expose capabilities available through their local protocols, not every tool or service offered by a provider's first-party desktop application.
