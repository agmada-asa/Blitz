# AI model settings

`/settings` stores one global model selection for each AI task in this personal Blitz deployment. There is no account-level configuration yet, so every browser and local worker connected to the same Convex deployment reads the same choices.

- Research controls proposal planning and source discovery.
- Card generation controls source preparation and the legacy `/api/generate` endpoint.
- Replies controls answers to questions attached to individual study cards.

Each local worker reads the saved choice before it starts an AI turn. A turn that is already running keeps the model it started with. Queued work uses the latest saved choice when the worker begins its next turn.

Enter a Codex model ID that is available to the account running the local workers. Model IDs are limited to letters, numbers, periods, underscores, colons, slashes, at signs, and hyphens. Blitz saves all three values together so a worker never receives a partial configuration.

Until settings are saved for the first time, the local workers retain the existing `BLITZ_CODEX_MODEL` fallback and then use `gpt-5.6-luna`. Once a settings record exists, its task-specific values take precedence over that legacy fallback. If Convex is temporarily unavailable, a worker falls back to the environment value or default rather than blocking a queued job.
