# AI model settings

Settings stores one provider, model and reasoning level for each of three tasks. Blitz is a personal local app, so every browser and worker connected to the same Convex database reads the same choices.

| Setting | Used by |
| --- | --- |
| **Research** (`research*`) | Find sources planning, podcast and audiobook scripts |
| **Practice questions** (`cardGeneration*`) | Question banks, past paper reading, mock exams and marking |
| **Teaching and chat** (`reply*`) | Teach, chat, lesson updates, compaction and prewarming |

A chat can override the reply choice for itself from its own model picker (see [workspace chat](workspace-chat.md#providers-and-limits)). Chat titles always use the cheapest available model with the lowest reasoning: on Codex, from the live catalogue, or from `CODEX_MODEL_OPTIONS` if it can't be read.

## The picker

Each task has one combined picker (`components/settings/model-reasoning-picker.tsx`): providers and favourites on the left, models in generations on the right, and a nested reasoning menu limited to what each model supports. A saved model the provider no longer lists stays visible under older models, so it can be replaced without losing it. Every change saves straight away as one complete configuration, so a worker never sees half a change; a turn already running keeps what it started with.

Where a provider publishes a catalogue, the picker uses its model IDs and reasoning levels. Loading them takes a few seconds because `/api/providers` checks every runtime, so each response is cached in the browser's local storage and shown until the next one arrives. Without one, Codex falls back to `CODEX_MODEL_OPTIONS`, which is kept identical to the runtime's catalogue. Convex checks the shape of a setting, and the provider adapter checks the model and reasoning again before a turn starts.

Claude Code offers the `sonnet`, `opus`, `haiku` and `fable` aliases with their reasoning levels. OpenCode and Antigravity only expose the provider's default reasoning.

## Auto

Every provider's picker starts with **Auto** (`auto`), which picks the provider's middle-tier model at each turn and falls back to a cheaper one when the account's plan doesn't offer it:

| Provider | Tries, in order |
| --- | --- |
| Claude Code | Sonnet, then Haiku |
| Codex | newest Terra, then newest Luna |
| OpenCode | Google's Gemini Neon, then Hydrogen, then Flash |
| Antigravity | Gemini Neon, then Hydrogen, then Flash |

Plans differ in which models they include, so Auto reads the signed-in account's own catalogue (`lib/server/providers/model-catalogs.ts`) rather than Blitz's curated lists, and takes the newest version of the first family listed (`AUTO_AI_MODEL_TIERS`, `resolveAutoAiModel` in `lib/ai-model-settings.ts`). A new version or a plan upgrade is picked up without a Blitz release. With no family listed, the catalogue's default model runs; with no catalogue, the curated list stands in. Claude Code and Antigravity catalogues are reused for five minutes, Codex and OpenCode for 30 seconds.

`turnBasics` in `run-text-turn.ts` settles Auto before anything else reads the selection, so Teach, chat, prewarming and background tasks all get a concrete model. The saved reasoning level is kept when the chosen model accepts it, and otherwise lowered to `medium`, then `low`; OpenCode and Antigravity always get their default. Chats save `auto` itself, so a chat follows a later plan change too.

## Defaults

Until settings are first saved, workers use `BLITZ_CODEX_MODEL` and `BLITZ_CODEX_EFFORT` if set, then Codex: `gpt-6-luna` at `medium` for Research and Practice questions, and Auto at `medium` for Teaching and chat. If Convex is briefly unavailable, a worker uses the same fallbacks rather than blocking queued work.

## Spending limits

A subscription has its own usage limits, but an API key bills every token. When Claude Code is signed in with an API key, each background turn (question banks, exams, podcasts, research, never chat or Teach) runs with a dollar cap and a cap on model round trips, which Claude Code enforces itself (`lib/spending-limits.ts`, `components/settings/spending-limit-settings.tsx`). The defaults are $3 and 10 steps per task, adjustable in Settings from $0.10 to $50. Codex and OpenCode have no equivalent control, and a subscription is never capped.

## Runtime checks

`npm run check:runtimes` checks the installed OpenCode and Antigravity against Blitz's requirements, and compares the live Codex catalogue with `CODEX_MODEL_OPTIONS`. Codex and Claude Code versions are checked by agent-engines. See [providers through agent-engines](agent-engines.md#checks).
