/** Verifies provider version gates, Codex protocol contract checks, and model catalog drift reports. */

import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  CODEX_PROTOCOL_CONTRACT,
  checkProviderVersion,
  codexProtocolProblems,
  diffModelCatalog,
  hasModelCatalogDrift,
  providerVersionGuidance,
  readCodexProtocolSurface,
} from "../lib/server/providers/runtime-compat.ts"

/** Keeps the Claude Code and OpenCode gates identical to the original registry checks. */
test("applies provider version gates", () => {
  assert.equal(
    checkProviderVersion("claude-code", "2.1.247 (Claude Code)").supported,
    false
  )
  assert.equal(
    checkProviderVersion("claude-code", "2.1.248 (Claude Code)").supported,
    true
  )
  assert.equal(checkProviderVersion("claude-code", "3.0.0").supported, true)
  assert.equal(checkProviderVersion("claude-code", "unknown").supported, false)
  assert.equal(checkProviderVersion("opencode", "1.18.20").supported, false)
  assert.equal(checkProviderVersion("opencode", "1.18.21").supported, true)
  assert.equal(checkProviderVersion("opencode", "1.19.0").supported, true)
  assert.equal(checkProviderVersion("opencode", "2.0.0").supported, false)
  assert.deepEqual(checkProviderVersion("codex", "codex-cli 0.162.1"), {
    supported: true,
    version: "0.162.1",
  })
  assert.equal(
    providerVersionGuidance("opencode"),
    "Update OpenCode to version 1.18.21 or newer within v1 for native permissions."
  )
  assert.equal(
    providerVersionGuidance("claude-code"),
    "Update Claude Code to version 2.1.248 or newer for restricted turns."
  )
  assert.equal(providerVersionGuidance("codex"), undefined)
})

/** Writes a minimal generated-schema directory with the given methods and definitions. */
async function writeSchema(
  directory: string,
  methods: Record<string, readonly string[]>,
  definitions: Record<string, unknown>
): Promise<void> {
  const files: Record<string, string> = {
    clientRequests: "ClientRequest.json",
    clientNotifications: "ClientNotification.json",
    serverNotifications: "ServerNotification.json",
    serverRequests: "ServerRequest.json",
  }
  for (const [group, file] of Object.entries(files)) {
    await writeFile(
      join(directory, file),
      JSON.stringify({
        oneOf: (methods[group] ?? []).map((method) => ({
          properties: { method: { enum: [method], type: "string" } },
        })),
        definitions: group === "serverNotifications" ? definitions : {},
      })
    )
  }
}

/** Mirrors how the generated schema nests enum values inside definitions. */
const COMPLETE_DEFINITIONS = {
  ThreadItem: {
    oneOf: CODEX_PROTOCOL_CONTRACT.enums.ThreadItem.map((type) => ({
      properties: { type: { enum: [type] } },
    })),
  },
  MessagePhase: {
    oneOf: CODEX_PROTOCOL_CONTRACT.enums.MessagePhase.map((phase) => ({
      enum: [phase],
    })),
  },
  TurnStatus: {
    enum: [...CODEX_PROTOCOL_CONTRACT.enums.TurnStatus, "inProgress"],
  },
  CodexErrorInfo: {
    oneOf: [
      { enum: CODEX_PROTOCOL_CONTRACT.enums.CodexErrorInfo },
      { properties: { responseStreamDisconnected: { type: "object" } } },
    ],
  },
}

/** Reports nothing for a complete schema and names each removed method or value. */
test("reports Codex protocol drift from a generated schema", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "blitz-schema-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const { enums: _enums, ...methods } = CODEX_PROTOCOL_CONTRACT
  void _enums
  await writeSchema(directory, methods, COMPLETE_DEFINITIONS)
  assert.deepEqual(
    codexProtocolProblems(await readCodexProtocolSurface(directory)),
    []
  )

  await writeSchema(
    directory,
    {
      ...methods,
      serverNotifications: methods.serverNotifications.filter(
        (method) => method !== "turn/completed"
      ),
    },
    {
      ...COMPLETE_DEFINITIONS,
      TurnStatus: { enum: ["completed", "failed"] },
      MessagePhase: undefined,
    }
  )
  assert.deepEqual(
    codexProtocolProblems(await readCodexProtocolSurface(directory)),
    [
      "Missing server notification: turn/completed",
      "Missing protocol definition: MessagePhase",
      "TurnStatus no longer includes interrupted",
    ]
  )
})

/** Compares models by ID and reasoning levels while ignoring label formatting. */
test("diffs the fallback model list against a live catalog", () => {
  const drift = diffModelCatalog(
    [
      { id: "gpt-6-luna", reasoningEfforts: ["low", "high"] },
      { id: "gpt-5.3-codex-spark", reasoningEfforts: ["low"] },
    ],
    [
      { id: "gpt-6.1-sol", reasoningEfforts: ["low"] },
      { id: "gpt-6-luna", reasoningEfforts: ["low", "xhigh"] },
    ]
  )
  assert.deepEqual(drift, {
    added: ["gpt-6.1-sol"],
    removed: ["gpt-5.3-codex-spark"],
    changed: [
      { id: "gpt-6-luna", fallback: ["low", "high"], live: ["low", "xhigh"] },
    ],
  })
  assert.equal(hasModelCatalogDrift(drift), true)
  assert.equal(
    hasModelCatalogDrift(
      diffModelCatalog(
        [{ id: "a", reasoningEfforts: ["low"] }],
        [{ id: "a", reasoningEfforts: ["low"] }]
      )
    ),
    false
  )
})

/** Lists every TypeScript source file below a directory. */
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  })
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

/**
 * Keeps the contract in step with the code: any Codex method string used in
 * the app must be declared, so `npm run check:runtimes` checks it against new
 * releases, and every declared method must still be used, so a method Blitz
 * has stopped calling cannot fail that check. The namespaces cover the Codex
 * protocol's method families; `initialize` and `initialized` have none and
 * are exempt from the second check.
 */
test("declares every Codex method the codebase uses", async () => {
  const root = join(import.meta.dirname, "..")
  const declared = new Set<string>([
    ...CODEX_PROTOCOL_CONTRACT.clientRequests,
    ...CODEX_PROTOCOL_CONTRACT.clientNotifications,
    ...CODEX_PROTOCOL_CONTRACT.serverNotifications,
    ...CODEX_PROTOCOL_CONTRACT.serverRequests,
  ])
  // The contract module lists every method itself, so it is not usage.
  const contract = join(root, "lib", "server", "providers", "runtime-compat.ts")
  const files = (
    await Promise.all(
      ["lib", "app", "components", "convex", "scripts"].map((dir) =>
        sourceFiles(join(root, dir))
      )
    )
  )
    .flat()
    .filter((file) => file !== contract)
  const used = new Set<string>()
  const undeclared = new Set<string>()
  for (const file of files) {
    const source = await readFile(file, "utf8")
    for (const match of source.matchAll(
      /["'`]((?:item|turn|thread|threadSection|model|modelProvider|mcpServer|mcpServerStatus|account|config|command|review|skills|plugin|fuzzyFileSearch|feedback)\/[A-Za-z/]+)["'`]/g
    )) {
      used.add(match[1]!)
      if (!declared.has(match[1]!))
        undeclared.add(`${match[1]} in ${file.slice(root.length + 1)}`)
    }
  }
  assert.deepEqual([...undeclared], [])
  assert.deepEqual(
    [...declared].filter((method) => method.includes("/") && !used.has(method)),
    []
  )
})
