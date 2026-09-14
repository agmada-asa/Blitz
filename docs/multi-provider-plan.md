# Multi-provider assistant plan

Status: implementation in progress. The current default remains Codex while the provider boundary and adapters are verified with contract tests and available local runtimes.

The first vertical slice is now present: task-specific provider settings, provider-neutral queue and session fields, Codex-compatible routing for chat and generation, Claude Code stream parsing, and ACP routing for OpenCode and the configured Antigravity runtime. Provider availability and capability checks still gate research and writable-agent behavior.

## Direction

Blitz should be the assistant that learners see. Codex, Claude Code, OpenCode, and Antigravity should be selectable local providers behind Blitz. Provider names belong in settings, availability states, and technical diagnostics. They should not define the chat or card experience.

The first implementation should extract a provider-neutral runtime contract around the existing Codex behavior. It should not rename every internal Codex type in one pass. Existing Codex records and the current bridge need a compatibility path while the new contract proves itself.

Provider selection should work at two levels:

- Settings provide one default provider, model, and provider-supported controls for each task: research, replies, and card generation.
- A queued job or new chat snapshots its resolved provider selection. An existing chat stays with its provider so a model change cannot invalidate its saved session.

Switching providers must be explicit. Blitz should never try to resume a session created by another provider.

## Current seams to preserve

The code already has useful boundaries, but they are named around one implementation:

- `lib/ai-model-settings.ts`, `convex/settings.ts`, and the settings components own the current flat model and reasoning configuration.
- `lib/server/codex-app-server.ts` owns the Codex JSON-RPC transport. `lib/server/card-chat.ts` turns it into streaming text, activity, interruption, and approval events.
- General chat persists `codexThreadId` and `codexTurnId` on `workspaceChats` and `workspaceChatMessages`. Card chat has the same shape on `conversations` and `conversationMessages`.
- `lib/server/learning-generation.ts` is already mostly provider-neutral. It accepts an injected text generator, bounds the response, validates the shared learning schema, and performs one repair attempt.
- `scripts/preparation-worker.ts`, `scripts/chat-worker.ts`, and `scripts/research-worker.ts` resolve settings before they call the Codex runner. Those workers are the main places that should move to one provider resolver.
- `lib/server/codex.ts` is the older one-shot card-generation path. It should either use the same adapter contract or be retired after its callers are confirmed.

## Reference implementation: T3 Code

T3 Code is a useful reference for the shape of this boundary. As checked on September 7, 2026, Antigravity is already present in the stable `v0.0.39` source, so it is not limited to a nightly build. The current README lists Google Antigravity as a supported provider, and the release includes its driver, ACP adapter, authentication, managed installation, and structured text-generation implementation. Nightly releases exist as a separate channel, but they are not required to get the Antigravity code. See the [T3 Code README](https://github.com/pingdotgg/t3code/blob/main/README.md), [stable release](https://github.com/pingdotgg/t3code/releases/tag/v0.0.39), and [built-in driver registry](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/builtInDrivers.ts).

The architecture is relevant to Blitz:

- T3 separates a driver kind from a provider instance. The driver identifies the integration; the instance identifies one account, profile, or configuration. This supports multiple instances of the same provider without global mutable state. See [`ProviderDriver.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/ProviderDriver.ts) and the [provider internals guide](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md).
- A `ProviderService` resolves instances, routes session-scoped work, and exposes one event stream to the rest of the app. The adapter owns provider protocol details. Blitz should follow this pattern with one server-side facade instead of letting routes and workers select adapters directly. See [`ProviderService.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/Services/ProviderService.ts).
- Interactive provider sessions and structured text generation are separate contracts. The interactive adapter handles turns, approvals, interruption, session recovery, and normalized events. The text-generation service handles short-lived, schema-constrained operations. Blitz should use the same split for chat, research, and card generation. See [`ProviderAdapter.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/Services/ProviderAdapter.ts) and [`TextGeneration.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/textGeneration/TextGeneration.ts).
- Session contracts include provider instance identity, resume cursors, capability checks, model selection, and explicit rollback or continuation support. Blitz should treat these as capability decisions, not assumptions shared by every provider. See the [provider contracts](https://github.com/pingdotgg/t3code/blob/v0.0.39/packages/contracts/src/provider.ts).
- Model discovery is manifest-driven with bundled and cached fallbacks. That is a useful later step for replacing the current hardcoded model lists without making provider startup depend on a remote catalog. See [`ModelManifest.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/ModelManifest.ts).

T3's Antigravity implementation is a managed ACP runtime, not a thin wrapper around an `antigravity` CLI. Each provider instance owns a Google profile while installed executable releases are shared. T3 manages executable versions with immutable release directories, an active pointer, and process leases, so an update does not invalidate a running session. Blitz should model the provider as `antigravity` plus a local instance/profile and runtime mode. It should not make a CLI path part of the product contract. See [`AntigravityDriver.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/Drivers/AntigravityDriver.ts), [`AntigravityInstallation.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/provider/AntigravityInstallation.ts), and the [Antigravity provider guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-antigravity.md).

The Antigravity text-generation path is especially relevant to card generation. T3 uses a short-lived helper in a temporary workspace, disables MCP and tools, rejects file, terminal, and user-input requests, bounds the response, extracts and validates the JSON object against a schema, and cleans up its session files. It also refuses this mode when the selected profile has hooks or MCP configuration that could run before tool denial. Blitz should expose structured card generation only when equivalent isolation and schema validation are confirmed. See [`AntigravityTextGeneration.ts`](https://github.com/pingdotgg/t3code/blob/v0.0.39/apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider-neutral runtime contract

Add a small server-only provider layer under `lib/server/providers/`.

Each provider definition should expose:

- a stable ID: `codex`, `claude-code`, `opencode`, or `antigravity`;
- a display name and local executable or connection mode;
- supported tasks and model lookup rules;
- capabilities such as streaming, resumable sessions, structured output, reasoning controls, web search, read-only sandboxing, workspace writes, and interactive approvals;
- a health or availability check that reports missing executables, authentication, or unsupported capabilities without exposing secrets.

The common adapter should cover only behavior Blitz needs:

```ts
interface ProviderAdapter {
  readonly provider: AiProviderId
  readonly providerInstanceId: string
  readonly capabilities: ProviderCapabilities
  startSession(options: ProviderSessionOptions): Promise<ProviderSession>
  resumeSession(
    sessionId: string,
    options: ProviderSessionOptions
  ): Promise<ProviderSession>
  sendTurn(
    sessionId: string,
    request: ProviderTurnRequest
  ): Promise<ProviderTurn>
  interruptTurn(sessionId: string, turnId: string): Promise<void>
  respondToRequest(requestId: string, response: unknown): Promise<void>
  readThread(sessionId: string): Promise<ProviderThread>
  rollbackThread(sessionId: string, checkpoint: string): Promise<void>
  streamEvents(listener: (event: ProviderEvent) => void): () => void
  close(): Promise<void>
}
```

The exact names can change during implementation. The important boundary is that a `ProviderService` resolves the instance and chat orchestration consumes normalized events rather than Codex notification names. `respondToRequest`, rollback, and model switching should be capability-gated. A separate structured-generation service or capability should handle card batches, because a provider that can stream text is not automatically able to enforce the learning JSON schema.

Persisted references should use provider-neutral fields such as `providerId`, `providerInstanceId`, `providerSessionId`, `providerTurnId`, and `resumeCursor`. Keep the existing Codex fields readable during migration. Do not store provider credentials, profile paths, or raw environment values in Convex.

## Model and provider settings

Replace the current model-only selection with a validated task selection:

```ts
type AiTask = "research" | "reply" | "cardGeneration"

type AiTaskSelection = {
  providerId: AiProviderId
  providerInstanceId?: string
  model: string
  controls: Record<string, string>
}
```

The runtime should normalize common controls without pretending they are universal. Codex `effort`, Claude Code thinking settings, OpenCode options, and Antigravity controls may not share the same values or even exist. The picker should render controls from provider capabilities and reject unsupported combinations before saving. A provider instance is a safe local key for an account or profile; credentials and profile paths remain local.

The settings work should cover:

1. Add provider IDs and task selections to `lib/ai-model-settings.ts`.
2. Keep legacy `researchModel`, `replyModel`, and `cardGenerationModel` readable as Codex selections. A missing provider field means `codex`.
3. Update `convex/settings.ts` and the `aiModelSettings` schema with a migration-safe read and write path.
4. Move all environment fallbacks behind one resolver. Keep `BLITZ_CODEX_MODEL`, `BLITZ_CODEX_EFFORT`, and `BLITZ_CODEX_WORKSPACE` as Codex compatibility fallbacks while introducing provider-specific local configuration.
5. Rework the settings picker to choose provider first, then model, then only the controls that provider supports. Show unavailable providers with a useful setup action or explanation.
6. Add a provider-aware reply picker to general chat. A provider change applies to a new chat or an explicit new session, not to a saved conversation that already has a session reference.

Research currently remains limited to providers that advertise the reviewed web-search capability. The alternate adapters are selectable for replies and card generation, while their research option stays hidden until live search is implemented and verified for that runtime.

Local executable paths, auth state, workspace roots, and command flags should stay in local configuration. Convex should store the safe selection, not machine-specific credentials or paths.

## Chat features

General chat, card chat, and project-agent chat should all call the same normalized turn service. The Codex adapter can keep the current app-server approval flow; other adapters can report only the capabilities they actually support.

The turn service should be a `ProviderService`-style facade. It resolves the provider instance from the persisted session reference, translates the request once, and maps each adapter's protocol into the product event vocabulary. This keeps provider-specific lifecycle behavior out of route handlers, workers, and Convex mutations.

The data changes should:

- add `providerId` and provider-neutral session and turn references to workspace chats, workspace messages, card conversations, and card messages;
- keep `codexThreadId` and `codexTurnId` until all reads, retries, and old records have migrated;
- snapshot provider selection on a new chat and on each queued card-chat request;
- preserve transcript recovery by replaying bounded Blitz history when a provider session is missing or cannot resume;
- map provider events to a small set of product events: text delta, activity, turn started, approval requested, turn completed, interrupted, and failed;
- show approval controls only when the provider advertises approvals. A provider without safe write support must stay read-only for Blitz tasks that do not have an equivalent policy;
- make provider-unavailable errors recoverable. The user should be able to retry the same provider or start a new chat with another available provider without losing the transcript.

The current chat route, card-chat worker, approval bridge, and project-agent policy should depend on the normalized service. Provider-specific policy translation belongs in the adapter, not in `app/api/chat/route.ts` or Convex mutations.

## Card generation and research

Card generation already validates output after the model call. Keep that validation as the product contract and move only the model invocation behind the provider layer.

Use a separate structured-generation contract for card batches and repair attempts. It can share model selection and health checks with chat, but it should not inherit interactive tools, approvals, or session state by accident. Antigravity should initially qualify for this contract only after its managed ACP profile is proven to have no hooks or MCP configuration that can run during a supposedly tool-free request.

For each preparation job:

- resolve the provider, model, and controls when the job is claimed or explicitly enqueued;
- store that selection in the immutable job snapshot so a retry is reproducible;
- use structured output when the provider supports it;
- otherwise parse bounded text, validate the shared learning schema, and use the existing single repair attempt;
- reject unsupported capabilities before sending source text, especially when research or workspace access is required;
- keep source text inside the existing untrusted-data boundary for every provider;
- retain enough internal provider detail for diagnostics while showing provider-neutral recovery copy to learners.

Research needs a separate capability check for live web search. A provider that can answer a prompt locally is not automatically a valid research provider. The research worker should report "web search is not available for this provider" rather than silently producing an unverified proposal.

The older `lib/server/codex.ts` path should be covered by the same provider contract before it is removed. Do not create a second provider-specific schema parser for each new adapter.

## Copy and assistant identity

Use "Blitz" for the assistant in customer-facing copy:

- `Ask Blitz`
- `Message Blitz`
- `Blitz is reading your context…`
- `Blitz could not finish that reply. Try again.`
- `Blitz can make mistakes. Check important details against your sources.`

Prompts should introduce the assistant as Blitz. Provider names can appear when the user is choosing a provider, checking availability, or reading a technical setup error. They should not appear in ordinary empty states, composer labels, loading states, or recovery copy.

Technical documentation should continue to name Codex where it describes the current bridge, environment variables, protocol, or migration compatibility. Product documentation should describe Blitz as the assistant and mention the selected provider only when the distinction helps the user make a choice.

## Provider rollout

### Phase 1: extract the contract

- Add provider IDs, capability types, selection validation, and normalized session references.
- Wrap the existing Codex app-server in the new adapter without changing its behavior.
- Add contract tests for start, resume, streaming deltas, interruption, approvals, structured output, timeouts, and safe shutdown.
- Migrate visible copy and prompts to Blitz while leaving internal Codex compatibility names in place.

### Phase 2: migrate persistence and workers

- Add provider-neutral fields with legacy fallbacks.
- Snapshot selections on chats, card-chat requests, research proposals, and preparation jobs.
- Move the three workers and both chat paths to the provider resolver.
- Verify old Codex chats, card conversations, and queued jobs still retry and resume.

### Phase 3: add providers one at a time

For Claude Code and OpenCode, verify the executable, authentication model, non-interactive invocation, streaming format, session resume, interruption, structured output, sandbox behavior, web search, and approval behavior on the target Mac before enabling the provider in the UI. Treat Antigravity as a managed ACP provider with a per-instance profile and runtime lifecycle rather than as a CLI integration. Verify its Google sign-in flow, model refresh, session resume, interruption, tool and MCP isolation, structured output, and capability reporting before enabling it. A provider can be available for replies while remaining unavailable for research or card generation if its capabilities do not meet those contracts.

### Phase 4: remove compatibility debt

- Backfill or lazily project old Codex IDs into provider-neutral fields.
- Stop writing new Codex-specific fields.
- Remove old environment fallbacks only after existing installations have a safe migration path.
- Rename internal modules only after the adapter boundary and persisted data no longer depend on those names.

## Acceptance checks

- Each enabled provider can be selected for the tasks it advertises; research stays restricted to providers with a reviewed web-search capability.
- A chat records its provider and never resumes through a different provider by accident.
- Streaming, pause, continue, retry, branching, citations, and approvals retain their current behavior where the selected provider supports them.
- Card generation produces the same validated learning contract across providers, or fails with a clear recoverable reason.
- Research refuses to run without the required web-search capability.
- Existing Codex records remain readable and retryable throughout the migration.
- No provider credentials, command output containing secrets, or machine paths enter Convex or user-facing copy.
- The product consistently calls the assistant Blitz.

## Open decisions

- Whether a provider can be chosen per message in a chat, or only when creating a chat. The safer first release is chat-level binding.
- Whether model catalogs are static curated lists, provider-reported lists, or a hybrid with a validated custom model field.
- Whether Blitz should manage Antigravity runtime installation and updates, or initially require a bundled or preinstalled ACP runtime. T3's managed installer is a useful reference, but it is a separate lifecycle feature from provider selection.
- What each provider exposes for session identity, structured output, web search, and approvals. Do not promise these capabilities before a local probe confirms them.
- Whether project-agent file editing should be enabled for providers other than Codex, or remain read-only until each provider has a reviewed sandbox and approval mapping.
