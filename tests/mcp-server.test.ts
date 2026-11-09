/**
 * Starts the MCP server the way an agent does and checks what a client sees: every tool's
 * annotations, the output schemas of the reads, its own description, and that a stopped Blitz is
 * a readable tool error. These need no running app and don't depend on the optional local module,
 * whose tools a plain client is never offered.
 */

import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/**
 * Connects a plain client to a new server with no Blitz to reach.
 *
 * @returns The client, which the caller closes.
 */
async function connected(): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["mcp/server.mjs"],
      env: {
        ...(process.env as Record<string, string>),
        // Nothing listens on port 1, so the app counts as stopped.
        BLITZ_URL: "http://127.0.0.1:1",
        BLITZ_CONVEX_URL: "http://127.0.0.1:1",
      },
    })
  )
  return client
}

test("a plain client sees the agent tools, each with its risk", async (t) => {
  const client = await connected()
  t.after(() => client.close())
  const { tools } = await client.listTools()
  const hints = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])
  )
  assert.deepEqual(hints, {
    today: true,
    list_modules: true,
    read_module: true,
    create_module: false,
    add_material: false,
    update_unit: false,
  })
  for (const tool of tools)
    assert.equal(tool.annotations?.openWorldHint, false, tool.name)
})

test("the reads declare the shape of their structured results", async (t) => {
  const client = await connected()
  t.after(() => client.close())
  const { tools } = await client.listTools()
  const shaped = tools
    .filter((tool) => tool.outputSchema)
    .map((tool) => tool.name)
  assert.deepEqual(shaped, ["today", "list_modules", "read_module"])
})

test("the server describes itself, with an icon and how to use it", async (t) => {
  const client = await connected()
  t.after(() => client.close())
  const info = client.getServerVersion()
  assert.equal(info?.title, "Blitz")
  assert.match(String(info?.icons?.[0]?.src), /^data:image\/svg\+xml;base64,/)
  assert.match(String(client.getInstructions()), /study app/)
})

test("a stopped Blitz is a tool error the agent can read", async (t) => {
  const client = await connected()
  t.after(() => client.close())
  const result = await client.callTool({ name: "today" })
  assert.equal(result.isError, true)
  const [first] = result.content as Array<{ text: string }>
  assert.match(first.text, /isn't running/)
})
