/** Tests deterministic file/drop/clipboard classification for the chat composer. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  clipboardImageFiles,
  droppedFiles,
} from "../lib/client/chat-composer-input.ts"

const file = (name: string, type: string) => ({ name, type })

test("clipboard classification intercepts images while preserving text paste", () => {
  const files = [
    file("notes.txt", "text/plain"),
    file("shot.png", "image/png"),
    file("photo.jpg", "image/jpeg"),
  ]
  assert.deepEqual(
    clipboardImageFiles(files).map((item) => item.name),
    ["shot.png", "photo.jpg"]
  )
  assert.deepEqual(clipboardImageFiles([file("notes.txt", "text/plain")]), [])
})

test("drop classification preserves every selected file in order", () => {
  const files = Array.from({ length: 12 }, (_, index) =>
    file(`source-${index}.pdf`, "application/pdf")
  )
  assert.deepEqual(
    droppedFiles(files).map((item) => item.name),
    files.map((item) => item.name)
  )
})
