#!/usr/bin/env node
/**
 * Serves Blitz to agents outside the app (Codex, Claude and Gemini agents) over
 * MCP stdio, using the official SDK: what's due today, the Library, a module's
 * units, creating modules and adding material to a unit. Each tool declares how
 * risky it is through annotations. The three reads also return their data as
 * `structuredContent`, so a client with a UI can use the tool an agent reads.
 * It needs Blitz running on this Mac and holds no state of its own.
 *
 * An optional local module, `host-plugin.mjs`, can add what one host's mini app
 * needs. Its tools are offered only to a client that says it can show MCP Apps,
 * because any other client wouldn't hide app-only tools from its model. A fresh
 * clone doesn't have the module and serves the tools below alone.
 *
 *   node mcp/server.mjs
 */

import { readFileSync } from "node:fs"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  addMaterial,
  BlitzError,
  connect,
  createModule,
  listModules,
  readModule,
  today,
} from "./blitz.mjs"

/** The MCP Apps extension's name in a client's capabilities. */
const APPS_EXTENSION = "io.modelcontextprotocol/ui"

/** Read by the agent when it connects: what Blitz is and how its tools fit together. */
const INSTRUCTIONS =
  "Blitz is the user's study app on their Mac. It teaches their course material back in live Teach sessions, drills it and runs mock exams. " +
  "A module is a course (e.g. a university module); a unit is a week or a lecture within it. " +
  "To put new material in Blitz: list_modules, read_module to see the existing units, then add_material with an existing unit's title or a new one. " +
  "Downloads that need a sign-in (Canvas, Blackboard) must be saved to a local file first and added as files. " +
  "Every tool needs Blitz running on the Mac; if it isn't, say so rather than retrying."

/** Annotations for a tool that only reads Blitz. */
const READS = { readOnlyHint: true, openWorldHint: false }

/**
 * Annotations for a tool that changes the Library and nothing outside it.
 * `add_material` may fetch a public link, but what it changes is still only Blitz.
 */
const WRITES = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
}

/** The address links start from, reachable from the user's phone where possible. */
const links = z.string()

/** Shape of `today`'s structured result. */
const TODAY_OUTPUT = {
  links,
  xp: z.number(),
  goal: z.number(),
  streak: z.number(),
  longest: z.number(),
  goalMet: z.boolean(),
  answered: z.number(),
  sections: z.number(),
  due: z.number(),
  week: z.array(z.object({ day: z.string(), xp: z.number() })),
  resume: z
    .object({
      module: z.string(),
      moduleTitle: z.string(),
      unit: z.string(),
      unitTitle: z.string(),
      detail: z.string(),
    })
    .nullable(),
}

/** Shape of `list_modules`' structured result. */
const LIBRARY_OUTPUT = {
  links,
  modules: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      units: z.number(),
      finished: z.number(),
      next: z.string().nullable(),
      unsorted: z.boolean(),
      lastStudiedAt: z.number().nullable(),
      progress: z.number(),
    })
  ),
}

/** One source in `read_module`'s structured result. */
const SOURCE = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  unreadable: z.boolean(),
  error: z.string().nullable(),
})

/** Shape of `read_module`'s structured result. */
const MODULE_OUTPUT = {
  id: z.string(),
  title: z.string(),
  links,
  units: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      taught: z.number(),
      started: z.boolean(),
      section: z.string().nullable(),
      questions: z.number(),
      answered: z.number(),
      correct: z.number(),
      sources: z.array(SOURCE),
    })
  ),
  unsorted: z.array(SOURCE),
  references: z.array(SOURCE),
  practice: z.object({
    due: z.number(),
    missed: z.number(),
    unanswered: z.number(),
    weak: z.array(
      z.object({
        title: z.string(),
        unit: z.string(),
        accuracy: z.number().nullable(),
      })
    ),
  }),
}

/**
 * Wraps a tool's work: connects to Blitz afresh, so a Blitz started after the
 * agent still works, and turns failures into results the agent can read.
 * Expected failures read as they are; anything else is reported without internals.
 *
 * @param work Takes the connection and arguments, and returns text, or text with its data.
 * @returns The tool's handler.
 */
function tool(work) {
  return async (args) => {
    try {
      const result = await work(await connect(), args)
      if (typeof result === "string")
        return { content: [{ type: "text", text: result }] }
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: result.data,
      }
    } catch (error) {
      const text =
        error instanceof BlitzError
          ? error.message
          : `Blitz failed: ${error instanceof Error ? error.message : String(error)}`
      return { content: [{ type: "text", text }], isError: true }
    }
  }
}

/**
 * Reads the local module, which a fresh clone doesn't have. Any other failure
 * is reported on standard error, so a broken module doesn't look like a missing one.
 *
 * @returns The module, or null without one.
 */
async function localModule() {
  try {
    return await import("./host-plugin.mjs")
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND")
      console.error(`Couldn't load host-plugin.mjs: ${error}`)
    return null
  }
}

const server = new McpServer(
  {
    name: "blitz",
    title: "Blitz",
    version: "0.1.0",
    icons: [
      {
        src: `data:image/svg+xml;base64,${readFileSync(new URL("./icon.svg", import.meta.url)).toString("base64")}`,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  },
  { instructions: INSTRUCTIONS }
)

server.registerTool(
  "today",
  {
    description:
      "What Blitz shows on its Library today: streak, XP against the daily goal, concepts due for review, and the lesson to continue, with links.",
    annotations: READS,
    outputSchema: TODAY_OUTPUT,
  },
  tool((blitz) => today(blitz))
)

server.registerTool(
  "list_modules",
  {
    description:
      "Every module in the Library with its units' Teach progress, the next unit to study, and a link.",
    annotations: READS,
    outputSchema: LIBRARY_OUTPUT,
  },
  tool((blitz) => listModules(blitz))
)

server.registerTool(
  "read_module",
  {
    description:
      "One module's learning path: each unit with its sources, how much has been taught and a link to teach it, plus sources not yet in a unit.",
    inputSchema: {
      module: z
        .string()
        .describe(
          "The module's title (or part of it, if only one matches) or id."
        ),
    },
    annotations: READS,
    outputSchema: MODULE_OUTPUT,
  },
  tool((blitz, args) => readModule(blitz, args.module))
)

server.registerTool(
  "create_module",
  {
    description:
      "Creates an empty module in the Library, e.g. for a new course.",
    inputSchema: {
      title: z
        .string()
        .describe('The module\'s title, e.g. "Software Engineering".'),
    },
    annotations: WRITES,
  },
  tool((blitz, args) => createModule(blitz, args.title))
)

server.registerTool(
  "add_material",
  {
    description:
      "Adds lecture slides, notes, transcripts or readings to a unit, ready to teach: local files (PDF, PowerPoint, Markdown, text, HTML), " +
      "public links, and/or notes written out. Creates the unit when no existing unit has that title. Reports each item separately.",
    inputSchema: {
      module: z.string().describe("The module's title or id."),
      unit: z
        .string()
        .describe(
          'An existing unit\'s title or id, or the title for a new unit, e.g. "Week 4: Normalisation".'
        ),
      files: z
        .array(z.string())
        .optional()
        .describe("Absolute paths of files on this Mac. Optional."),
      links: z
        .array(z.string())
        .optional()
        .describe("Public http(s) links to PDFs, slides or pages. Optional."),
      notes: z
        .string()
        .optional()
        .describe("Notes to add as a Markdown source. Optional."),
      notes_title: z
        .string()
        .optional()
        .describe("A title for the notes. Optional: their first line."),
    },
    annotations: WRITES,
  },
  tool((blitz, args) => addMaterial(blitz, args))
)

// The local module's tools stay off until the client has introduced itself. Their `enabled` flag
// is set directly, because `enable()` would announce a list change nobody needs.
const local = await localModule()
const appOnly = local?.register(server) ?? []
for (const item of appOnly) item.enabled = false
server.server.oninitialized = () => {
  const showsApps =
    server.server.getClientCapabilities()?.extensions?.[APPS_EXTENSION]
  if (showsApps) for (const item of appOnly) item.enabled = true
}

await server.connect(new StdioServerTransport())
