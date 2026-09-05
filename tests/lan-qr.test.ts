/** Verifies terminal QR code generation for local LAN addresses. */

import assert from "node:assert/strict"
import test from "node:test"
import { formatTerminalQr } from "../scripts/lan-qr.mjs"

test("formats a terminal QR code with ANSI styling and compact block characters", async () => {
  const url = "http://192.168.0.55:3001"
  const qrOutput = await formatTerminalQr(url)

  assert.equal(typeof qrOutput, "string")
  assert.ok(qrOutput.length > 0)
  // Terminal small format uses ANSI escape sequences for contrast.
  assert.ok(qrOutput.includes("\x1b["))
  // Terminal small format uses unicode half and full block elements.
  assert.ok(qrOutput.includes("█") || qrOutput.includes("▀") || qrOutput.includes("▄"))
})
