/** Tests research proposal validation and local worker persistence without a model or network call. */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildResearchProposalPrompt,
  parseResearchProposal,
  validateResearchProposal,
} from "../lib/server/research-proposal.ts"
import {
  runResearchProposalStep,
  type ResearchProposalQueue,
} from "../lib/server/research-worker.ts"

/** Returns a valid proposal fixture with explicit unverified and generated labels. */
function validProposal() {
  return {
    scope: "Sound design fundamentals for synthesis and arrangement.",
    topics: ["Synthesis", "Arrangement"],
    sources: [
      {
        url: "https://example.com/synthesis",
        title: "Synthesis guide",
        reason: "Introduces the requested concepts.",
        verification: "suggested-unverified",
      },
    ],
    generatedNotes: [
      {
        label: "generated",
        title: "Signal flow glossary",
        description: "Outline terms for oscillators, filters, and envelopes.",
        reason: "Provides a compact review aid after approval.",
      },
    ],
  }
}

/** Rejects fabricated verification and unsafe source URLs. */
test("proposal validation keeps suggested sources unverified", () => {
  const proposal = validateResearchProposal(validProposal())
  assert.equal(proposal.sources[0]?.verification, "suggested-unverified")
  assert.equal(proposal.generatedNotes[0]?.label, "generated")
  assert.throws(
    () =>
      validateResearchProposal({
        ...validProposal(),
        sources: [{ ...validProposal().sources[0], verification: "checked" }],
      }),
    /remain unverified/
  )
  assert.throws(
    () =>
      validateResearchProposal({
        ...validProposal(),
        sources: [{ ...validProposal().sources[0], url: "http://127.0.0.1/x" }],
      }),
    /safe public HTTP URL/
  )
})

/** Requires strict JSON and an approval-first planning prompt. */
test("proposal parser rejects wrappers and prompt forbids importing", () => {
  const fenced = parseResearchProposal(
    `\`\`\`json\n${JSON.stringify(validProposal())}\n\`\`\``
  )
  assert.equal(fenced.scope, validProposal().scope)
  assert.throws(() =>
    parseResearchProposal(`prefix ${JSON.stringify(validProposal())}`)
  )
  const prompt = buildResearchProposalPrompt("help me learn sound design")
  assert.match(prompt, /Do not download, import, apply/)
  assert.match(prompt, /suggested-unverified/)
})

/** Commits one valid proposal through an injected queue without Codex or network access. */
test("research worker validates and completes one leased proposal", async () => {
  const completed: unknown[] = []
  const failed: unknown[] = []
  const queue: ResearchProposalQueue = {
    claimNext: async () => ({
      proposalId: "proposal-1",
      projectId: "project-1",
      requestId: "request-1",
      request: "help me learn sound design",
      leaseToken: "lease-1",
    }),
    complete: async (value) => {
      completed.push(value)
    },
    fail: async (value) => {
      failed.push(value)
    },
  }
  const workspace = await mkdtemp(join(tmpdir(), "blitz-research-worker-test-"))
  try {
    const result = await runResearchProposalStep({
      queue,
      workerId: "worker-1",
      workspaceDirectory: workspace,
      runTurn: async (_prompt, turnOptions) => {
        turnOptions.onEvent?.({
          type: "activity",
          notification: {
            method: "item/completed",
            params: { item: { type: "webSearch" } },
          },
        })
        return { text: JSON.stringify(validProposal()) }
      },
    })
    assert.equal(result.status, "ready")
    assert.equal(completed.length, 1)
    assert.equal(failed.length, 0)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test("research worker rejects sources when hosted search was not observed", async () => {
  const failed: unknown[] = []
  const queue: ResearchProposalQueue = {
    claimNext: async () => ({
      proposalId: "proposal-no-search",
      projectId: "project-1",
      requestId: "request-1",
      request: "help me learn sound design",
      leaseToken: "lease-1",
    }),
    complete: async () => {
      throw new Error("unexpected completion")
    },
    fail: async (value) => {
      failed.push(value)
    },
  }
  const workspace = await mkdtemp(
    join(tmpdir(), "blitz-research-worker-no-search-")
  )
  try {
    const result = await runResearchProposalStep({
      queue,
      workerId: "worker-1",
      workspaceDirectory: workspace,
      runTurn: async () => ({ text: JSON.stringify(validProposal()) }),
    })
    assert.equal(result.status, "failed")
    assert.equal(failed.length, 1)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})
