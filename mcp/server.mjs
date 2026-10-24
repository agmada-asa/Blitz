#!/usr/bin/env node
/**
 * Serves Blitz to agents outside the app (Codex, Claude and Gemini
 * agents) over MCP stdio: what's due today, the Library, a module's units,
 * creating modules and adding material to a unit. It needs Blitz running on
 * this Mac and holds no state of its own. Standard output carries newline-
 * delimited JSON-RPC messages only.
 *
 * When a host runs it as a plug-in (`BLITZ_OCEAN=1`, set by its plug-in manifest)
 * it also serves that host's widget and the mini app's tools.
 *
 *   node mcp/server.mjs
 */

import { createInterface } from "node:readline"
import {
  addMaterial,
  BlitzError,
  connect,
  createModule,
  listModules,
  readModule,
  today,
} from "./blitz.mjs"

const PROTOCOL = "2025-06-18"

/** Whether Ocean started the server as its plug-in, so its widget and mini app tools are on offer. */
const OCEAN = process.env.BLITZ_OCEAN === "1"

/** The plug-in's tools and widget. The module is local-only, so a fresh clone serves without them. */
const { APP_TOOL_NAMES = new Set(), APP_TOOLS = [], callAppTool, readResource, RESOURCE_DEFINITIONS = [] } =
  process.env.BLITZ_OCEAN === "1" ? await import("./host-plugin.mjs").catch(() => ({})) : {}

/** Read by the agent when it connects: what Blitz is and how its tools fit together. */
const INSTRUCTIONS =
  "Blitz is the user's study app on their Mac. It teaches their course material back in live Teach sessions, drills it and runs mock exams. " +
  "A module is a course (e.g. a university module); a unit is a week or a lecture within it. " +
  "To put new material in Blitz: list_modules, read_module to see the existing units, then add_material with an existing unit's title or a new one. " +
  "Downloads that need a sign-in (Canvas, Blackboard) must be saved to a local file first and added as files. " +
  "Every tool needs Blitz running on the Mac; if it isn't, say so rather than retrying."

/** A string argument's schema. */
const text = (description) => ({ type: "string", description })

/** The tools listed to agents, with their argument schemas. */
const TOOLS = [
  {
    name: "today",
    description:
      "What Blitz shows on its Library today: streak, XP against the daily goal, concepts due for review, and the lesson to continue, with links.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_modules",
    description:
      "Every module in the Library with its units' Teach progress, the next unit to study, and a link.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_module",
    description:
      "One module's learning path: each unit with its sources, how much has been taught and a link to teach it, plus sources not yet in a unit.",
    inputSchema: {
      type: "object",
      properties: {
        module: text(
          "The module's title (or part of it, if only one matches) or id."
        ),
      },
      required: ["module"],
    },
  },
  {
    name: "create_module",
    description:
      "Creates an empty module in the Library, e.g. for a new course.",
    inputSchema: {
      type: "object",
      properties: {
        title: text('The module\'s title, e.g. "Software Engineering".'),
      },
      required: ["title"],
    },
  },
  {
    name: "add_material",
    description:
      "Adds lecture slides, notes, transcripts or readings to a unit, ready to teach: local files (PDF, PowerPoint, Markdown, text, HTML), " +
      "public links, and/or notes written out. Creates the unit when no existing unit has that title. Reports each item separately.",
    inputSchema: {
      type: "object",
      properties: {
        module: text("The module's title or id."),
        unit: text(
          'An existing unit\'s title or id, or the title for a new unit, e.g. "Week 4: Normalisation".'
        ),
        files: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths of files on this Mac. Optional.",
        },
        links: {
          type: "array",
          items: { type: "string" },
          description:
            "Public http(s) links to PDFs, slides or pages. Optional.",
        },
        notes: text("Notes to add as a Markdown source. Optional."),
        notes_title: text("A title for the notes. Optional: their first line."),
      },
      required: ["module", "unit"],
    },
  },
]

/** Runs one tool against a fresh connection to Blitz and returns its text. */
async function callTool(name, args) {
  if (OCEAN && APP_TOOL_NAMES.has(name)) return callAppTool(name, args)
  const blitz = await connect()
  switch (name) {
    case "today":
      return today(blitz)
    case "list_modules":
      return listModules(blitz)
    case "read_module":
      return readModule(blitz, args.module)
    case "create_module":
      return createModule(blitz, args.title)
    case "add_material":
      return addMaterial(blitz, args)
    default:
      throw new BlitzError(`No tool called ${name}.`)
  }
}

/** Writes one JSON-RPC message. */
function write(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
}

/** Answers one request; notifications (no id) need no answer. */
async function handle(message) {
  if (!message || typeof message !== "object" || message.id === undefined)
    return
  const { id, method, params } = message
  switch (method) {
    case "initialize":
      return write({
        id,
        result: {
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : PROTOCOL,
          capabilities: OCEAN ? { tools: {}, resources: {} } : { tools: {} },
          serverInfo: { name: "blitz", version: "0.1.0" },
          instructions: INSTRUCTIONS,
        },
      })
    case "tools/list":
      return write({
        id,
        result: { tools: OCEAN ? [...TOOLS, ...APP_TOOLS] : TOOLS },
      })
    case "resources/list":
      return write({
        id,
        result: { resources: OCEAN ? RESOURCE_DEFINITIONS : [] },
      })
    case "resources/read":
      try {
        return write({ id, result: await readResource?.(params?.uri) })
      } catch (error) {
        return write({
          id,
          error: {
            code: -32002,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
    case "tools/call":
      try {
        const result = await callTool(params?.name, params?.arguments ?? {})
        return write({
          id,
          result: { content: [{ type: "text", text: result }] },
        })
      } catch (error) {
        // Expected failures read as-is; anything else is reported without internals.
        const text =
          error instanceof BlitzError
            ? error.message
            : `Blitz failed: ${error instanceof Error ? error.message : String(error)}`
        return write({
          id,
          result: { content: [{ type: "text", text }], isError: true },
        })
      }
    case "ping":
      return write({ id, result: {} })
    default:
      return write({
        id,
        error: { code: -32601, message: `Unknown method ${method}` },
      })
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return write({ id: null, error: { code: -32700, message: "Parse error" } })
  }
  void handle(message)
})
