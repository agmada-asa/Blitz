# Blitz MCP server

Lets agents outside Blitz (for example Codex, Claude and Gemini agents) see what's due and put course material into Blitz, over MCP stdio.

```bash
node mcp/server.mjs
```

| Tool              | What it does                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `today`           | Streak, XP against the daily goal, concepts due for review (in total and by module) and the lesson to continue.    |
| `list_modules`    | Every module with its units' Teach progress, the next unit, concepts due and whether it's archived.                |
| `read_module`     | One module's units, each with its sources and Teach progress, plus unsorted and reference sources and week gaps.   |
| `recent_material` | Units that got new files in the last few days, and whether they've been taught or need `update_unit`.             |
| `weak_concepts`   | Concepts answered wrongly most often, weakest first, across every module or one.                                   |
| `exams`           | A module's readiness estimate and its past and mock papers with their best scores.                                 |
| `create_module`   | Creates an empty module.                                                                                           |
| `add_material`    | Adds local files, public links and written notes to a unit, creating the unit when no existing one has that title. |
| `update_unit`     | Updates a unit's lesson from files added after it was planned, keeping progress and past answers.                  |
| `organise`        | Renames, archives or restores a module; renames or moves a unit; moves a source between units. Deletes nothing.    |

A module's gaps come from the week numbers in its unit titles ("Week 4", "Wk 4", "W4"): weeks between the first and last that have no unit, and weeks not taught although a later one has been.

Material goes through the same upload and extraction routes as the web app's Add material dialog, so it is ready to teach afterwards. A new unit that ends up with nothing in it is removed again. Links that redirect to a sign-in page are refused: download those to a file first.

A lesson already planned doesn't use new files until it is updated. `add_material` and `read_module` say when a unit needs that; `update_unit`, or `update_lesson: true` on `add_material`, starts it. The update runs in the app in the background, so the tool returns straight away and `read_module` shows when it has finished.

The server keeps no state and needs Blitz running on the same computer. It finds the app on `3007` (the background server or `npm run dev:lan`) or `3008` (the desktop app's own copy); a `npm run dev` checkout on `3009` needs `BLITZ_URL`. It reads the Convex deployment from `.convex/local/default/config.json`. `BLITZ_URL` and `BLITZ_CONVEX_URL` override them. Links in its answers use the Mac's Tailscale name when it has one, so they open on a phone too; `BLITZ_PUBLIC_URL` overrides that.

It's built on the official MCP SDK. Each tool declares its risk through annotations, and every read also returns its data as `structuredContent` for clients with a UI.

An optional local module, `mcp/host-plugin.mjs`, can add what one host's mini app needs. It isn't in this repository, and its tools are offered only to a client that says it can show MCP Apps, because other clients wouldn't hide app-only tools from their model.

To add it to an agent, register the command, for example:

```bash
claude mcp add blitz -s user -- node /path/to/Blitz/mcp/server.mjs
codex mcp add blitz -- node /path/to/Blitz/mcp/server.mjs
```
