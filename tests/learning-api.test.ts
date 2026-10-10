/** Tests bounded HTTP payload validation before requests reach Convex. */

import assert from "node:assert/strict"
import test from "node:test"

import {
  LearningApiError,
  parseAnswerRequest,
  parseEventRequest,
  readLearningJson,
} from "../lib/server/learning-api.ts"

test("parses answer and passive event contracts without scoring client data", () => {
  assert.deepEqual(
    parseAnswerRequest({
      projectId: "project_1",
      itemId: "item_1",
      clientEventId: "event_1",
      occurredAt: 123,
      answer: ["choice_b", "choice_a"],
    }),
    {
      projectId: "project_1",
      itemId: "item_1",
      clientEventId: "event_1",
      occurredAt: 123,
      answer: ["choice_b", "choice_a"],
    }
  )
  assert.deepEqual(
    parseEventRequest({
      projectId: "project_1",
      itemId: "item_1",
      clientEventId: "event_2",
      occurredAt: 456,
      eventType: "skip",
    }).eventType,
    "skip"
  )
})

test("accepts typed list answers with some blanks left empty", () => {
  const request = parseAnswerRequest({
    projectId: "project_1",
    itemId: "item_1",
    clientEventId: "event_3",
    occurredAt: 789,
    answer: ["O(log n)", ""],
  })
  assert.deepEqual(request.answer, ["O(log n)", ""])
  assert.throws(() =>
    parseAnswerRequest({
      projectId: "project_1",
      itemId: "item_1",
      clientEventId: "event_4",
      occurredAt: 789,
      answer: ["", " "],
    })
  )
})

test("rejects invalid answer shapes and event types with 400 errors", () => {
  assert.throws(
    () =>
      parseAnswerRequest({
        projectId: "project_1",
        itemId: "item_1",
        clientEventId: "event_1",
        occurredAt: 123,
        answer: [],
      }),
    (error: unknown) => {
      assert.ok(error instanceof LearningApiError)
      assert.equal(error.status, 400)
      return true
    }
  )
  assert.throws(
    () =>
      parseEventRequest({
        projectId: "project_1",
        itemId: "item_1",
        clientEventId: "event_2",
        occurredAt: 456,
        eventType: "answer",
      }),
    /Event type is invalid/
  )
})

test("bounds JSON request bodies before parsing", async () => {
  const request = new Request("http://localhost/api/learning/answer", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(40_000) }),
  })
  await assert.rejects(readLearningJson(request), /Request body is too large/)
})
