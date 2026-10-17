# Blitz MCP server

Lets agents outside Blitz (for example Ocean's Codex, Claude and Gemini agents) see what's due and put course material into Blitz, over MCP stdio.

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

Material goes through the same upload and extraction routes as the web app's Add material dialog, so it is ready to teach afterwards. A new unit that ends up with nothing in it is removed again. Links that redirect to a sign-in page are refused: download those to a file first.

The server keeps no state and needs Blitz running on the same Mac. It finds the app on `3007` (`npm run dev:lan`) or `3008` (the desktop shell) and the Convex deployment from `.convex/local/default/config.json`. `BLITZ_URL` and `BLITZ_CONVEX_URL` override them. Links in its answers use the Mac's Tailscale name when it has one, so they open on a phone too; `BLITZ_PUBLIC_URL` overrides that.

Run by Ocean as a plug-in (`BLITZ_OCEAN=1`, from `ocean.plugin.json`), it also serves Ocean's Today widget and the `app_*` tools behind the mini app in `ocean-app/` (see `mcp/ocean.mjs` and `ocean-app/README.md`).

To add it to an agent, register the command, for example:

```bash
claude mcp add blitz -s user -- node /path/to/Blitz/mcp/server.mjs
codex mcp add blitz -- node /path/to/Blitz/mcp/server.mjs
```
