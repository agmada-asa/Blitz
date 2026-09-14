/** Tests deterministic file/drop/clipboard classification for the chat composer. */
import assert from "node:assert/strict"
import test from "node:test"
import {
  clipboardImageFiles,
  droppedFiles,
  limitComposerFiles,
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

test("drop classification preserves all file order and composer slot limits", () => {
  const files = [
    file("a.pdf", "application/pdf"),
    file("b.png", "image/png"),
    file("c.txt", "text/plain"),
  ]
  assert.deepEqual(
    droppedFiles(files).map((item) => item.name),
    ["a.pdf", "b.png", "c.txt"]
  )
  assert.deepEqual(
    limitComposerFiles(files, 2).map((item) => item.name),
    ["a.pdf", "b.png"]
  )
  assert.deepEqual(limitComposerFiles(files, 0), [])
})
