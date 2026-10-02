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
    // Chat turns keep the user's plugins; project config stays off.
    assert.equal(env.OPENCODE_PURE, undefined)
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1")
    const background = openCodeEnvironment(
      { ...request, ephemeral: true },
      "blitz-fixture"
    )
    assert.deepEqual(JSON.parse(background.OPENCODE_PERMISSION!)["*"], "deny")
    assert.equal(JSON.parse(background.OPENCODE_PERMISSION!).read, undefined)
    assert.equal(background.OPENCODE_PURE, "1")
  }
})

/** Read-only and no-approval chats can read and search, but never edit or run commands. */
test("OpenCode read-only chats allow read tools and protect env files", () => {
  for (const extra of [
    { approvalPolicy: "never" as const },
    { approvalPolicy: "on-request" as const, sandbox: "read-only" as const },
  ]) {
    const permission = JSON.parse(
      openCodeEnvironment(
        {
          selection: { providerId: "opencode" as const, model: "default" },
          workspaceDirectory: "/tmp/blitz-test",
          prompt: "Question",
          ...extra,
        },
        "blitz-fixture"
      ).OPENCODE_PERMISSION!
    )
    assert.equal(permission["*"], "deny")
    assert.equal(permission.grep, "allow")
    assert.equal(permission.skill, "allow")
    assert.equal(permission.read["*"], "allow")
    assert.equal(permission.read["*.env"], "deny")
    assert.equal(permission.edit, undefined)
    assert.equal(permission.bash, undefined)
  }
})
