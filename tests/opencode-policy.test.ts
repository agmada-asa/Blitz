/** Checks native OpenCode policy overrides without modifying user settings or running a model. */
import test from "node:test"
import assert from "node:assert/strict"
import { openCodeEnvironment } from "../lib/server/providers/opencode-policy.ts"

/** Reads the permission rules a turn's environment gives OpenCode, globally and on the Blitz agent. */
function permissions(env: NodeJS.ProcessEnv, agentName: string) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  return { config, global: config.permission, agent: config.agent[agentName].permission }
}

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
    const { config, global, agent } = permissions(env, "blitz-fixture")
    assert.equal(agent["*"], action)
    assert.equal(agent.task, "deny")
    assert.deepEqual(global, agent)
    assert.equal(config.default_agent, "blitz-fixture")
    // OpenCode v2 has neither of v1's variables; project config stays off.
    assert.equal(env.OPENCODE_PURE, undefined)
    assert.equal(env.OPENCODE_PERMISSION, undefined)
    assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, "1")
    const background = permissions(
      openCodeEnvironment({ ...request, ephemeral: true }, "blitz-fixture"),
      "blitz-fixture"
    )
    assert.equal(background.agent["*"], "deny")
    assert.equal(background.agent.read, undefined)
    assert.deepEqual(background.global, background.agent)
  }
})

/** Read-only and no-approval chats can read and search, but never edit or run commands. */
test("OpenCode read-only chats allow read tools and protect env files", () => {
  for (const extra of [
    { approvalPolicy: "never" as const },
    { approvalPolicy: "on-request" as const, sandbox: "read-only" as const },
  ]) {
    const { agent: permission } = permissions(
      openCodeEnvironment({ ...extra }, "blitz-fixture"),
      "blitz-fixture"
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
