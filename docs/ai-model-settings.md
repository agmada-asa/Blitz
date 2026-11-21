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

## Defaults

Until settings are first saved, workers use `BLITZ_CODEX_MODEL` and `BLITZ_CODEX_EFFORT` if set, then Codex with `gpt-6-luna`: `medium` reasoning for Research and Practice questions, `low` for Teaching and chat. If Convex is briefly unavailable, a worker uses the same fallbacks rather than blocking queued work.

## Spending limits

A subscription has its own usage limits, but an API key bills every token. When Claude Code is signed in with an API key, each background turn (question banks, exams, podcasts, research, never chat or Teach) runs with a dollar cap and a cap on model round trips, which Claude Code enforces itself (`lib/spending-limits.ts`, `components/settings/spending-limit-settings.tsx`). The defaults are $3 and 10 steps per task, adjustable in Settings from $0.10 to $50. Codex and OpenCode have no equivalent control, and a subscription is never capped.

## Runtime checks

`npm run check:runtimes` checks the installed OpenCode and Antigravity against Blitz's requirements, and compares the live Codex catalogue with `CODEX_MODEL_OPTIONS`. Codex and Claude Code versions are checked by agent-engines. See [providers through agent-engines](agent-engines.md#checks).
