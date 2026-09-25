/** Verifies agent draft validation before any generated lesson reaches Convex. */

import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { validateLessonDraft } from "../lib/content-generation.ts"
import { readContentDrafts } from "../lib/server/content-generation-drafts.ts"

/** Returns a valid existing-concept draft for boundary tests. */
function page() {
  return {
    key: "topic-one",
    conceptId: "concept-1",
    topicTitle: "Topic",
    conceptTitle: "One",
    title: "One",
    bodyMarkdown: "A short explanation with **one** point.",
    sourceReferences: [{ sourceId: "source-1", locator: "Page 2" }],
    questions: [],
  }
}

test("rejects unknown source references and overlong compact pages", () => {
  assert.throws(() =>
    validateLessonDraft(
      {
        ...page(),
        sourceReferences: [{ sourceId: "other", locator: "Page 2" }],
      },
      3,
      new Set(["source-1"]),
      "source-1"
    )
  )
  assert.throws(() =>
    validateLessonDraft(
      {
        ...page(),
        bodyMarkdown: Array.from({ length: 91 }, () => "word").join(" "),
      },
      1,
      new Set(["source-1"]),
      "source-1"
    )
  )
})

test("rejects a choice whose answer is absent from its options", () => {
  assert.throws(() =>
    validateLessonDraft(
      {
        ...page(),
        questions: [
          {
            type: "single-choice",
            question: "Which answer is correct?",
            feedback: "The first one is correct.",
            options: [
              { id: "a", text: "First" },
              { id: "b", text: "Second" },
            ],
            correctOptionId: "missing",
          },
        ],
      },
      3,
      new Set(["source-1"]),
      "source-1"
    )
  )
})

test("rejects duplicate retired question IDs in one lesson", () => {
  assert.throws(() =>
    validateLessonDraft(
      { ...page(), retireQuestionIds: ["question-1", "question-1"] },
      3,
      new Set(["source-1"]),
      "source-1"
    )
  )
})

test("rejects generated remote images and raw HTML", () => {
  for (const bodyMarkdown of [
    "A fact with ![tracking](https://example.com/image.png).",
    'A fact with <img src="https://example.com/image.png">.',
  ])
    assert.throws(() =>
      validateLessonDraft(
        { ...page(), bodyMarkdown },
        3,
        new Set(["source-1"]),
        "source-1"
      )
    )
})

test("reads every manifest page and rejects a symlinked page directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blitz-content-test-"))
  try {
    await mkdir(join(directory, "pages"))
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        version: 1,
        sourceId: "source-1",
        pages: ["pages/topic-one.json"],
        coverage: [
          { sectionId: "chunk-1", status: "included", pageKeys: ["topic-one"] },
        ],
      })
    )
    await writeFile(
      join(directory, "pages", "topic-one.json"),
      JSON.stringify(page())
    )
    assert.equal(
      (
        await readContentDrafts(
          directory,
          "source-1",
          3,
          new Set(["source-1"]),
          new Set(["chunk-1"])
        )
      ).pages.length,
      1
    )
    await rm(join(directory, "pages"), { recursive: true })
    await symlink(tmpdir(), join(directory, "pages"))
    await assert.rejects(
      readContentDrafts(
        directory,
        "source-1",
        3,
        new Set(["source-1"]),
        new Set(["chunk-1"])
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects a manifest that leaves an extracted section unaccounted for", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blitz-content-coverage-"))
  try {
    await mkdir(join(directory, "pages"))
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        version: 1,
        sourceId: "source-1",
        pages: ["pages/topic-one.json"],
        coverage: [
          { sectionId: "chunk-1", status: "included", pageKeys: ["topic-one"] },
        ],
      })
    )
    await writeFile(
      join(directory, "pages", "topic-one.json"),
      JSON.stringify(page())
    )
    await assert.rejects(
      readContentDrafts(
        directory,
        "source-1",
        3,
        new Set(["source-1"]),
        new Set(["chunk-1", "chunk-2"])
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
