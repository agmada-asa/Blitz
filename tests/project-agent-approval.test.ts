/** Verifies approval decisions remain explicit, scoped, and faithful to the displayed request. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  projectApprovalDetails,
  projectApprovalResponse,
} from "../lib/server/project-agent-approval.ts"

test("denied commands never grant an operation or session exception", () => {
  const request = {
    id: 1,
    method: "item/commandExecution/requestApproval",
    params: { command: "touch coursework.md" },
  }
  assert.deepEqual(projectApprovalResponse(request, false), {
    decision: "decline",
  })
  assert.deepEqual(projectApprovalResponse(request, true), {
    decision: "accept",
  })
  assert.deepEqual(
    projectApprovalResponse(
      { ...request, method: "unknown/requestApproval" },
      true
    ),
    { decision: "decline" }
  )
  assert.match(projectApprovalDetails(request), /touch coursework.md/)
})

test("permission approvals grant only the reviewed permissions for this turn", () => {
  const permissions = {
    fileSystem: { write: ["/tmp/coursework"] },
    network: { enabled: true },
  }
  const request = {
    id: "approval",
    method: "item/permissions/requestApproval",
    params: { permissions },
  }
  assert.deepEqual(projectApprovalResponse(request, true), {
    permissions,
    scope: "turn",
  })
  assert.deepEqual(projectApprovalResponse(request, false), {
    permissions: { fileSystem: null, network: null },
    scope: "turn",
  })
})

test("review details include proposed changes and reject oversized undisplayed requests", () => {
  const request = {
    id: 1,
    method: "item/fileChange/requestApproval",
    params: { itemId: "change" },
  }
  assert.match(
    projectApprovalDetails(request, {
      changes: [{ path: "guide.md", diff: "+Guide" }],
    }),
    /\+Guide/
  )
  assert.throws(
    () => projectApprovalDetails(request, { diff: "x".repeat(20_001) }),
    /too large/
  )
})
