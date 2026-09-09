/** Exercises native image attachment MIME and signature validation. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  isChatImageMimeType,
  validateChatImageBytes,
} from "../lib/server/chat-attachments.ts"
import { chatStorageId } from "../lib/server/source-files.ts"

test("accepts supported image MIME types and strips parameters", () => {
  assert.equal(isChatImageMimeType("image/png; charset=binary"), true)
  assert.equal(isChatImageMimeType("image/jpeg"), true)
  assert.equal(isChatImageMimeType("image/svg+xml"), false)
  assert.equal(isChatImageMimeType("text/plain"), false)
})

test("validates native image signatures", () => {
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Array(4).fill(0),
  ])
  assert.doesNotThrow(() => validateChatImageBytes(png, "image/png"))
  assert.throws(
    () => validateChatImageBytes(png, "image/jpeg"),
    /does not match/
  )
  assert.throws(
    () => validateChatImageBytes(new Uint8Array(4), "image/png"),
    /too large or empty/
  )
})

test("maps opaque draft tokens to stable server-owned storage IDs", () => {
  const token = "a".repeat(32)
  assert.match(chatStorageId(token), /^chat-[a-f0-9]{64}$/)
  assert.equal(chatStorageId(token), chatStorageId(token))
  assert.throws(() => chatStorageId("../../escape"), /invalid/)
})
