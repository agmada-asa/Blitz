# AI model settings

`/settings` stores one global model and reasoning selection for each AI task in this personal Blitz deployment. There is no account-level configuration yet, so every browser and local worker connected to the same Convex deployment reads the same choices.

- Research controls proposal planning and source discovery.
- Card generation controls source preparation and the legacy `/api/generate` endpoint.
- Replies controls answers to questions attached to individual study cards.

Each local worker reads the saved choices before it starts an AI turn. A turn that is already running keeps the model and reasoning level it started with. Queued work uses the latest saved choices when the worker begins its next turn.

The settings page uses one combined model-and-reasoning picker per task rather than free-text model IDs or separate dropdowns. Its menu separates model generations, and each model opens a nested reasoning menu limited to the levels it supports. Existing custom saved model IDs remain visible so they can be replaced without losing a prior configuration. Picker changes stay local until `Save AI settings`; Blitz saves every model and reasoning choice together so a worker never receives a partial configuration.

The general `/chat` workspace also includes one compact Reply model picker alongside the attachment button. Its menu separates model generations, and each model opens a nested reasoning menu. Changing a selection saves the shared Reply setting immediately and briefly pauses the composer until the change is confirmed. The next general or card-chat reply then uses that saved pair.

Until settings are saved for the first time, the local workers retain the existing `BLITZ_CODEX_MODEL` and `BLITZ_CODEX_EFFORT` fallbacks, then use `gpt-6-luna` with task-specific defaults: `medium` for research and card generation, and `low` for replies. Once a settings record exists, its task-specific values take precedence over those legacy fallbacks. If Convex is temporarily unavailable, a worker falls back to the environment values or defaults rather than blocking a queued job.
