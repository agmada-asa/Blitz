# Multi-provider assistant plan

Status: planning only. The current default remains Codex until the provider boundary and each adapter have been verified on the local Mac.

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
  startSession(options: ProviderSessionOptions): Promise<ProviderSession>
  resumeSession(sessionId: string, options: ProviderSessionOptions): Promise<ProviderSession>
  startTurn(sessionId: string, request: ProviderTurnRequest): Promise<ProviderTurn>
  interruptTurn(sessionId: string, turnId: string): Promise<void>
  streamEvents(listener: (event: ProviderEvent) => void): () => void
  close(): Promise<void>
}
```

The exact names can change during implementation. The important boundary is that chat orchestration consumes normalized events rather than Codex notification names. A separate structured-generation method or capability should handle card batches, because a provider that can stream text is not automatically able to enforce the learning JSON schema.

Persisted references should use provider-neutral fields such as `providerId`, `providerSessionId`, and `providerTurnId`. Keep the existing Codex fields readable during migration. Do not store provider credentials or raw environment values in Convex.

## Model and provider settings

Replace the current model-only selection with a validated task selection:

```ts
type AiTask = "research" | "reply" | "cardGeneration"

type AiTaskSelection = {
  providerId: AiProviderId
  model: string
  controls: Record<string, string>
}
```

The runtime should normalize common controls without pretending they are universal. Codex `effort`, Claude Code thinking settings, OpenCode options, and Antigravity controls may not share the same values or even exist. The picker should render controls from provider capabilities and reject unsupported combinations before saving.

The settings work should cover:

1. Add provider IDs and task selections to `lib/ai-model-settings.ts`.
2. Keep legacy `researchModel`, `replyModel`, and `cardGenerationModel` readable as Codex selections. A missing provider field means `codex`.
3. Update `convex/settings.ts` and the `aiModelSettings` schema with a migration-safe read and write path.
4. Move all environment fallbacks behind one resolver. Keep `BLITZ_CODEX_MODEL`, `BLITZ_CODEX_EFFORT`, and `BLITZ_CODEX_WORKSPACE` as Codex compatibility fallbacks while introducing provider-specific local configuration.
5. Rework the settings picker to choose provider first, then model, then only the controls that provider supports. Show unavailable providers with a useful setup action or explanation.
6. Add a provider-aware reply picker to general chat. A provider change applies to a new chat or an explicit new session, not to a saved conversation that already has a session reference.

Local executable paths, auth state, workspace roots, and command flags should stay in local configuration. Convex should store the safe selection, not machine-specific credentials or paths.

## Chat features

General chat, card chat, and project-agent chat should all call the same normalized turn service. The Codex adapter can keep the current app-server approval flow; other adapters can report only the capabilities they actually support.

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

For Claude Code, OpenCode, and Antigravity, verify the executable, authentication model, non-interactive invocation, streaming format, session resume, interruption, structured output, sandbox behavior, web search, and approval behavior on the target Mac before enabling the provider in the UI. A provider can be available for replies while remaining unavailable for research or card generation if its capabilities do not meet those contracts.

### Phase 4: remove compatibility debt

- Backfill or lazily project old Codex IDs into provider-neutral fields.
- Stop writing new Codex-specific fields.
- Remove old environment fallbacks only after existing installations have a safe migration path.
- Rename internal modules only after the adapter boundary and persisted data no longer depend on those names.

## Acceptance checks

- Each enabled provider can be selected independently for research, replies, and card generation.
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
- What Antigravity exposes for session identity, structured output, web search, and approvals. Do not promise these capabilities before a local probe confirms them.
- Whether project-agent file editing should be enabled for providers other than Codex, or remain read-only until each provider has a reviewed sandbox and approval mapping.
