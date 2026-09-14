/** Checks native OpenCode policy overrides without modifying user settings or running a model. */
import test from "node:test"
import assert from "node:assert/strict"
import { openCodeEnvironment } from "../lib/server/providers/opencode-policy.ts"

/** All tools receive the selected native rule, while agent switching cannot bypass it. */
test("OpenCode isolates a dedicated agent and forces background tool denial", () => {
  for (const [approvalPolicy, action] of [
    ["never", "deny"],
    ["on-request", "ask"],
    ["full-access", "allow"],
  ] as const) {
    const request = {
      selection: { providerId: "opencode" as const, model: "default" },
      workspaceDirectory: "/tmp/blitz-test",
      prompt: "Question",
      approvalPolicy,
    }
    const env = openCodeEnvironment(request, "blitz-fixture")
    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
    assert.equal(config.agent["blitz-fixture"].permission["*"], action)
    assert.equal(config.agent["blitz-fixture"].permission.task, "deny")
    assert.equal(config.default_agent, "blitz-fixture")
    assert.equal(env.OPENCODE_PURE, "1")
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1")
    assert.equal(
      JSON.parse(
        openCodeEnvironment({ ...request, ephemeral: true }, "blitz-fixture")
          .OPENCODE_PERMISSION!
      )["*"],
      "deny"
    )
  }
})
