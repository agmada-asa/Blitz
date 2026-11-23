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
| `recent_material` | Units that got new files in the last few days, and whether they've been taught or need `update_unit`.              |
| `weak_concepts`   | Concepts answered wrongly most often, weakest first, across every module or one.                                   |
| `exams`           | A module's readiness estimate and its past and mock papers with their best scores.                                 |
| `create_module`   | Creates an empty module.                                                                                           |
| `add_material`    | Adds local files, public links and written notes to a unit, creating the unit when no existing one has that title. |
| `update_unit`     | Updates a unit's lesson from files added after it was planned, keeping progress and past answers.                  |
| `organise`        | Renames, archives or restores a module; renames or moves a unit; moves a source between units. Deletes nothing.    |

## Parameters

Wherever a tool takes a `module`, it accepts the module's id, its exact title, or part of the title when only one module contains it. If no module matches, or several do, the error lists the candidates. `update_unit` and `organise` find a unit the same way. `add_material` doesn't: its `unit` has to be an existing unit's id or exact title, and anything else creates a new unit with that title.

`today` and `list_modules` take no parameters.

**`read_module`**

| Parameter | Type   | Required | Meaning                       |
| --------- | ------ | -------- | ----------------------------- |
| `module`  | string | yes      | The module's title, or its id |

```json
{ "module": "Databases" }
```

**`recent_material`**

| Parameter | Type   | Required | Meaning                                        |
| --------- | ------ | -------- | ---------------------------------------------- |
| `days`    | number | no       | How many days back to look, 1 to 60. Default 7 |

```json
{ "days": 14 }
```

**`weak_concepts`**

| Parameter | Type   | Required | Meaning                                    |
| --------- | ------ | -------- | ------------------------------------------ |
| `module`  | string | no       | Limit to one module. Default: every module |
| `limit`   | number | no       | How many to list, 1 to 50. Default 10      |

```json
{ "module": "Databases", "limit": 5 }
```

**`exams`**

| Parameter | Type   | Required | Meaning                       |
| --------- | ------ | -------- | ----------------------------- |
| `module`  | string | yes      | The module's title, or its id |

```json
{ "module": "Databases" }
```

Papers are sat in the app, not through this tool.

**`create_module`**

| Parameter | Type   | Required | Meaning                                               |
| --------- | ------ | -------- | ----------------------------------------------------- |
| `title`   | string | yes      | The new module's title, e.g. `"Software Engineering"` |

```json
{ "title": "Software Engineering" }
```

**`add_material`**

| Parameter       | Type     | Required | Meaning                                                                                               |
| --------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `module`        | string   | yes      | The module's title, or its id                                                                         |
| `unit`          | string   | yes      | An existing unit's exact title or id, or the title for a new unit                                     |
| `files`         | string[] | no       | Absolute paths of local files: PDF, PowerPoint, Markdown, text or HTML, up to 100 MB each. `~/` works |
| `links`         | string[] | no       | Public http(s) links to PDFs, slides or pages                                                         |
| `notes`         | string   | no       | Text to add as a Markdown source                                                                      |
| `notes_title`   | string   | no       | A title for the notes. Default: their first line                                                      |
| `update_lesson` | boolean  | no       | Also update the unit's lesson if it's already been planned. Default `false`                           |

It needs at least one of `files`, `links` or `notes`. Each item is reported separately, so one bad file doesn't stop the rest.

```json
{
  "module": "Databases",
  "unit": "Week 4: Normalisation",
  "files": ["/path/to/week4-slides.pdf"],
  "links": ["https://example.com/normal-forms.pdf"],
  "notes": "Lecturer said 3NF vs BCNF will be on the exam.",
  "notes_title": "Exam hints",
  "update_lesson": true
}
```

**`update_unit`**

| Parameter | Type   | Required | Meaning                                                     |
| --------- | ------ | -------- | ----------------------------------------------------------- |
| `module`  | string | yes      | The module's title, or its id                               |
| `unit`    | string | yes      | The unit's title, part of it if only one matches, or its id |

```json
{ "module": "Databases", "unit": "Week 4" }
```

It returns straight away. `read_module` shows when the update has finished.

**`organise`**

| Parameter  | Type   | Required | Meaning                                                                                                                                  |
| ---------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `action`   | string | yes      | `rename_module`, `archive_module`, `restore_module`, `rename_unit`, `move_unit` or `move_source`                                         |
| `module`   | string | yes      | The module's title, or its id                                                                                                            |
| `unit`     | string | depends  | `rename_unit`, `move_unit`: the unit to change. `move_source`: the unit to move it to; leave it out to take the source out of every unit |
| `title`    | string | depends  | `rename_module`, `rename_unit`: the new title                                                                                            |
| `position` | number | depends  | `move_unit`: where to put it in the learning path, counting from 1                                                                       |
| `source`   | string | depends  | `move_source`: the source's id, or its file name (or part of it) when no other source shares it                                          |

One call per line:

```jsonl
{ "action": "rename_unit", "module": "Databases", "unit": "Week 4", "title": "Week 4: Normal forms" }
{ "action": "move_unit", "module": "Databases", "unit": "Week 4", "position": 2 }
{ "action": "move_source", "module": "Databases", "source": "week4-slides.pdf", "unit": "Week 5: Transactions" }
{ "action": "archive_module", "module": "Databases" }
```

Archiving keeps a module's material, answers and review schedules, and `restore_module` brings it back. Nothing is ever deleted.

## How it works

A module's gaps come from the week numbers in its unit titles ("Week 4", "Wk 4", "W4"): weeks between the first and last that have no unit, and weeks not taught although a later one has been.

Material goes through the same upload and extraction routes as the web app's Add material dialog, so it is ready to teach afterwards. A new unit that ends up with nothing in it is removed again. Links that redirect to a sign-in page are refused: download those to a file first.

A lesson already planned doesn't use new files until it is updated. `add_material` and `read_module` say when a unit needs that; `update_unit`, or `update_lesson: true` on `add_material`, starts it. The update runs in the app in the background, so the tool returns straight away and `read_module` shows when it has finished.

The server keeps no state and needs Blitz running on the same computer. It finds the app on `3007` (the background server or `npm run dev:lan`) or `3008` (the desktop app's own copy); a `npm run dev` checkout on `3009` needs `BLITZ_URL`. It reads the Convex deployment from `.convex/local/default/config.json`. `BLITZ_URL` and `BLITZ_CONVEX_URL` override them. Links in its answers use the Mac's Tailscale name when it has one, so they open on a phone too; `BLITZ_PUBLIC_URL` overrides that.

It's built on the official MCP SDK. Each tool declares its risk through annotations, and every read also returns its data as `structuredContent` for clients with a UI.

An optional local module, `mcp/host-plugin.mjs`, can add what one host's mini app needs. It isn't in this repository, and its tools are offered only to a client that says it can show MCP Apps, because other clients wouldn't hide app-only tools from their model.

## Adding it to an agent

Register the command, for example:

```bash
claude mcp add blitz -s user -- node /path/to/Blitz/mcp/server.mjs
codex mcp add blitz -- node /path/to/Blitz/mcp/server.mjs
```
