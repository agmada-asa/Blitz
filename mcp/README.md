# Blitz MCP server

Lets agents outside Blitz (for example Codex, Claude and Gemini agents) see what's due and put course material into Blitz, over MCP stdio.

```bash
node mcp/server.mjs
```

| Tool            | What it does                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `today`         | Streak, XP against the daily goal, concepts due for review and the lesson to continue, as on the Library.          |
| `list_modules`  | Every module with its units' Teach progress and the next unit.                                                     |
| `read_module`   | One module's units, each with its sources and Teach progress, plus unsorted and reference sources.                 |
| `create_module` | Creates an empty module.                                                                                           |
| `add_material`  | Adds local files, public links and written notes to a unit, creating the unit when no existing one has that title. |
| `update_unit`   | Updates a unit's lesson from files added after it was planned, keeping progress and past answers.                  |

Material goes through the same upload and extraction routes as the web app's Add material dialog, so it is ready to teach afterwards. A new unit that ends up with nothing in it is removed again. Links that redirect to a sign-in page are refused: download those to a file first.

A lesson already planned doesn't use new files until it is updated. `add_material` and `read_module` say when a unit needs that; `update_unit`, or `update_lesson: true` on `add_material`, starts it. The update runs in the app in the background, so the tool returns straight away and `read_module` shows when it has finished.

The server keeps no state and needs Blitz running on the same Mac. It finds the app on `3007` (`npm run dev:lan`) or `3008` (the desktop shell) and the Convex deployment from `.convex/local/default/config.json`. `BLITZ_URL` and `BLITZ_CONVEX_URL` override them. Links in its answers use the Mac's Tailscale name when it has one, so they open on a phone too; `BLITZ_PUBLIC_URL` overrides that.

It's built on the official MCP SDK. Each tool declares its risk through annotations, and `today`, `list_modules` and `read_module` also return their data as `structuredContent` for clients with a UI.

An optional local module, `mcp/host-plugin.mjs`, can add what one host's mini app needs. It isn't in this repository, and its tools are offered only to a client that says it can show MCP Apps, because other clients wouldn't hide app-only tools from their model.

To add it to an agent, register the command, for example:

```bash
claude mcp add blitz -s user -- node /path/to/Blitz/mcp/server.mjs
codex mcp add blitz -- node /path/to/Blitz/mcp/server.mjs
```
