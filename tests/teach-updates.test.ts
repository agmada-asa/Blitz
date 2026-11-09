/**
 * Verifies lesson updates: which files count as new, how a model's analysis is
 * merged without losing progress, what `Next section` teaches afterwards, and
 * how the session is told. No provider or database is involved.
 */

import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTeachPrompt,
  type TeachOutline,
  type TeachSectionPlan,
} from "../lib/teach.ts"
import { teachTurnFocus } from "../lib/teach-focus.ts"
import { MAX_UPDATED_TEACH_SECTIONS } from "../lib/teach-limits.ts"
import {
  buildTeachUpdatePrompt,
  parseTeachUpdateReply,
} from "../lib/teach-update-prompt.ts"
import {
  followTeachReplies,
  isTeachUpdateRunning,
  mergeTeachUpdate,
  nextTeachTarget,
  TEACH_UPDATE_LEASE_MS,
  teachNewSources,
  teachReplyUpdateLabels,
  teachUpdateDividerText,
  teachUpdateInstruction,
  type TeachUpdateReply,
  type TeachUpdateState,
} from "../lib/teach-updates.ts"

/** A lesson with three sections, part way through the second. */
const outline: TeachOutline = {
  title: "Hash tables",
  sections: [
    { id: "s1", title: "What a hash table is", concepts: ["Hash function"] },
    { id: "s2", title: "Collisions", concepts: ["Chaining"] },
    { id: "s3", title: "Load factor", concepts: ["Resizing"] },
  ],
}

/** The lesson state most tests merge into. */
const state: TeachUpdateState = {
  outline,
  sectionIndex: 1,
  taughtSectionIds: ["s1", "s2"],
  pending: [],
  updateCount: 0,
}

/** Returns one reply entry for a current section. */
function kept(id: string, title: string) {
  return { id, title, concepts: [], change: "unchanged" as const, note: "" }
}

/** The analysis: section one changes and a topic is added after it. */
const reply: TeachUpdateReply = {
  summary: "The slides add universal hashing.",
  sections: [
    {
      id: "s1",
      title: "A new title the model invented",
      concepts: ["Universal hashing"],
      change: "updated",
      note: "Adds universal hashing.",
    },
    {
      id: "",
      title: "Open addressing",
      concepts: ["Linear probing"],
      change: "added",
      note: "A new probing scheme.",
    },
    kept("s2", "Collisions"),
    kept("s3", "Load factor"),
  ],
}

/** Builds a source fact with sensible defaults. */
function source(id: string, overrides: Partial<Parameters<typeof teachNewSources>[2][number]> = {}) {
  return {
    id,
    filename: `${id}.pdf`,
    status: "ready",
    hasText: true,
    unsupported: false,
    createdAt: 100,
    ...overrides,
  }
}

test("new files are those the lesson has not covered, and only readable ones", () => {
  const sources = [
    source("seen"),
    source("new", { createdAt: 300 }),
    source("processing", { status: "processing", createdAt: 400 }),
    source("empty", { hasText: false, createdAt: 500 }),
    source("unreadable", { unsupported: true, createdAt: 600 }),
    source("failed", { status: "failed", createdAt: 700 }),
  ]
  assert.deepEqual(
    teachNewSources(["seen"], 0, sources).map((item) => item.id),
    ["new"]
  )
})

test("a lesson from before updates treats files newer than its session as new", () => {
  const sources = [source("old", { createdAt: 100 }), source("later", { createdAt: 900 })]
  assert.deepEqual(
    teachNewSources(undefined, 500, sources).map((item) => item.id),
    ["later"]
  )
})

test("an expired update no longer holds its lesson", () => {
  const run = { status: "running" as const, startedAt: 1_000_000 }
  assert.equal(isTeachUpdateRunning(run, 1_000_000 + 1), true)
  assert.equal(isTeachUpdateRunning(run, 1_000_000 + TEACH_UPDATE_LEASE_MS + 1), false)
  assert.equal(isTeachUpdateRunning({ ...run, status: "failed" }, 1_000_001), false)
  assert.equal(isTeachUpdateRunning(null, 1), false)
})

test("merging keeps every section, its id and its place", () => {
  const result = mergeTeachUpdate(state, reply)
  assert.deepEqual(
    result.outline.sections.map((section) => section.id),
    ["s1", "u1n1", "s2", "s3"]
  )
  assert.equal(result.outline.sections[1].title, "Open addressing")
  assert.deepEqual(result.dropped, 0)
})

test("a taught section keeps its title and gains concepts", () => {
  const [first] = mergeTeachUpdate(state, reply).outline.sections
  assert.equal(first.title, "What a hash table is")
  assert.deepEqual(first.concepts, ["Hash function", "Universal hashing"])
})

test("an untaught section may be renamed and its concepts replaced", () => {
  const result = mergeTeachUpdate(state, {
    summary: "",
    sections: [
      kept("s1", "What a hash table is"),
      kept("s2", "Collisions"),
      {
        id: "s3",
        title: "Load factor and resizing",
        concepts: ["Amortised resizing"],
        change: "updated",
        note: "Adds amortised analysis.",
      },
    ],
  })
  assert.equal(result.outline.sections[2].title, "Load factor and resizing")
  assert.deepEqual(result.outline.sections[2].concepts, ["Amortised resizing"])
})

test("only taught sections the files change are queued to be taught again", () => {
  const result = mergeTeachUpdate(state, reply)
  assert.deepEqual(result.pending, [
    { id: "s1", change: "updated", note: "Adds universal hashing." },
    { id: "u1n1", change: "added", note: "A new probing scheme." },
  ])
  const untaught = mergeTeachUpdate(state, {
    summary: "",
    sections: [{ id: "s3", title: "Load factor", concepts: [], change: "updated", note: "x" }],
  })
  assert.deepEqual(untaught.pending, [])
  assert.deepEqual(untaught.sections, [{ id: "s3", change: "updated" }])
})

test("a changed section the learner went past without being taught is queued too", () => {
  const finished = {
    ...state,
    sectionIndex: outline.sections.length,
    taughtSectionIds: ["s1", "s3"],
    plan: [
      { id: "s1", mode: "teach" },
      { id: "s2", mode: "skip" },
      { id: "s3", mode: "teach" },
    ] satisfies TeachSectionPlan,
  }
  const result = mergeTeachUpdate(finished, {
    summary: "",
    sections: [{ id: "s2", title: "Collisions", concepts: [], change: "updated", note: "n" }],
  })
  assert.deepEqual(result.pending.map((entry) => entry.id), ["s2"])
  assert.equal(result.outline.sections[result.sectionIndex].id, "s3")
})

test("the learner stays on the same section after an insert", () => {
  const result = mergeTeachUpdate(state, reply)
  assert.equal(result.outline.sections[result.sectionIndex].id, "s2")
})

test("sections the reply forgets, and invented or repeated ones, change nothing", () => {
  const result = mergeTeachUpdate(state, {
    summary: "",
    sections: [
      { id: "ghost", title: "Not added", concepts: [], change: "updated", note: "" },
      { id: "s1", title: "A", concepts: [], change: "unchanged", note: "" },
      { id: "", title: "What a hash table is", concepts: [], change: "added", note: "" },
    ],
  })
  assert.deepEqual(
    result.outline.sections.map((section) => section.id),
    ["s1", "s2", "s3"]
  )
  assert.deepEqual(result.pending, [])
})

test("a wrong id with a known title still updates that section", () => {
  const result = mergeTeachUpdate(state, {
    summary: "",
    sections: [{ id: "x9", title: "collisions", concepts: [], change: "updated", note: "n" }],
  })
  assert.deepEqual(result.pending.map((entry) => entry.id), ["s2"])
})

test("the outline never grows past its limit, and reports what was dropped", () => {
  const many = Array.from({ length: MAX_UPDATED_TEACH_SECTIONS + 3 }, (_, index) => ({
    id: "",
    title: `Topic ${index}`,
    concepts: [],
    change: "added" as const,
    note: "",
  }))
  const result = mergeTeachUpdate(state, { summary: "", sections: many })
  assert.equal(result.outline.sections.length, MAX_UPDATED_TEACH_SECTIONS)
  assert.equal(result.dropped, 6)
})

test("a changed section the check marked known is skimmed; added sections are taught", () => {
  const plan: TeachSectionPlan = [
    { id: "s1", mode: "skip" },
    { id: "s2", mode: "teach" },
    { id: "s3", mode: "skip" },
  ]
  const result = mergeTeachUpdate({ ...state, plan }, reply)
  assert.deepEqual(result.plan, [
    { id: "s1", mode: "skim" },
    { id: "u1n1", mode: "teach" },
    { id: "s2", mode: "teach" },
    { id: "s3", mode: "skip" },
  ])
})

test("a finished unit reopens only when there is something new to teach", () => {
  const finished = {
    ...state,
    sectionIndex: outline.sections.length,
    taughtSectionIds: ["s1", "s2", "s3"],
  }
  const changed = mergeTeachUpdate(finished, reply)
  assert.equal(changed.outline.sections[changed.sectionIndex].id, "s3")
  const unchanged = mergeTeachUpdate(finished, {
    summary: "",
    sections: [kept("s1", "What a hash table is")],
  })
  assert.equal(unchanged.sectionIndex, unchanged.outline.sections.length)
})

test("a section still waiting from an earlier update stays in the queue", () => {
  const result = mergeTeachUpdate(
    { ...state, pending: [{ id: "s2", change: "updated", note: "Earlier." }] },
    { summary: "", sections: [] }
  )
  assert.deepEqual(result.pending, [{ id: "s2", change: "updated", note: "Earlier." }])
})

test("a second update adds to a queued section's note instead of replacing it", () => {
  const result = mergeTeachUpdate(
    { ...state, pending: [{ id: "s2", change: "updated", note: "Adds chaining detail." }] },
    {
      summary: "",
      sections: [{ id: "s2", title: "Collisions", concepts: [], change: "updated", note: "Adds an exam rule." }],
    }
  )
  assert.equal(result.pending[0].note, "Adds chaining detail. Adds an exam rule.")
})

/** Merges the standard reply and returns state ready for `nextTeachTarget`. */
function merged() {
  const result = mergeTeachUpdate(state, reply)
  return {
    outline: result.outline,
    plan: null,
    taughtSectionIds: new Set(state.taughtSectionIds),
    pending: result.pending,
    sectionIndex: result.sectionIndex,
  }
}

test("Next section goes back over changed sections, then carries on", () => {
  const first = nextTeachTarget(merged())
  assert.deepEqual(first.kind === "section" && first.section.id, "s1")
  // s1 taught again: the queue shrinks and the learner has moved back to it.
  const afterS1 = {
    ...merged(),
    pending: merged().pending.filter((entry) => entry.id !== "s1"),
    sectionIndex: 0,
  }
  const second = nextTeachTarget(afterS1)
  assert.deepEqual(second.kind === "section" && second.section.id, "u1n1")
  const afterAdded = {
    ...afterS1,
    pending: [],
    sectionIndex: 1,
    taughtSectionIds: new Set([...state.taughtSectionIds, "u1n1"]),
  }
  const third = nextTeachTarget(afterAdded)
  assert.deepEqual(third.kind === "section" && third.section.id, "s3")
})

test("Next section skips known sections and ends with the recap", () => {
  const known = nextTeachTarget({
    outline,
    plan: [
      { id: "s1", mode: "teach" },
      { id: "s2", mode: "teach" },
      { id: "s3", mode: "skip" },
    ],
    taughtSectionIds: new Set(["s1", "s2"]),
    pending: [],
    sectionIndex: 1,
  })
  assert.equal(known.kind, "done")
})

test("Next section starts at the first section when nothing has been taught", () => {
  const first = nextTeachTarget({
    outline,
    taughtSectionIds: new Set(),
    pending: [],
    sectionIndex: 0,
  })
  assert.equal(first.kind === "section" && first.section.id, "s1")
})

test("an instruction replaces Next section and carries what changed", () => {
  const instruction = teachUpdateInstruction("Next section", merged())
  assert.ok(instruction)
  assert.match(instruction.message, /^Teach section 1: What a hash table is/)
  assert.match(instruction.message, /universal hashing/)
  assert.equal(instruction.focus, "What a hash table is")
})

test("the instruction asks for the recap when nothing is left", () => {
  const instruction = teachUpdateInstruction("Next section", {
    outline,
    taughtSectionIds: new Set(["s1", "s2", "s3"]),
    pending: [],
    sectionIndex: 2,
  })
  assert.match(instruction!.message, /section block with body done/)
})

test("a jump to a queued section carries its note; other messages pass through", () => {
  const jump = teachUpdateInstruction("Teach section 1: What a hash table is", merged())
  assert.match(jump!.message, /universal hashing/)
  assert.equal(teachUpdateInstruction("Teach section 3: Collisions", merged()), undefined)
  assert.equal(teachUpdateInstruction("Why does chaining work?", merged()), undefined)
})

test("citations follow the section an update chose", () => {
  assert.equal(teachTurnFocus("Next section", outline, 1, "Open addressing"), "Open addressing")
})

test("markers before an update count as taught but no longer move the learner", () => {
  const followed = followTeachReplies(
    {
      sectionIndex: 1,
      taughtSectionIds: [],
      pending: [{ id: "s1", change: "updated", note: "" }],
      lastUpdateAt: 500,
      sections: outline.sections,
    },
    [
      { id: "m1", createdAt: 100, sectionId: "s3" },
      { id: "m2", createdAt: 200, done: true },
    ]
  )
  assert.equal(followed.sectionIndex, 1)
  assert.deepEqual([...followed.taughtSectionIds], ["s3"])
  assert.deepEqual(followed.pending.map((entry) => entry.id), ["s1"])
})

test("a reply after an update moves the learner and clears the queue live", () => {
  const followed = followTeachReplies(
    {
      sectionIndex: 1,
      taughtSectionIds: ["s1"],
      pending: [{ id: "s1", change: "updated", note: "" }],
      lastUpdateAt: 500,
      sections: outline.sections,
    },
    [{ id: "m3", createdAt: 600, sectionId: "s1" }]
  )
  assert.equal(followed.sectionIndex, 0)
  assert.deepEqual(followed.pending, [])
})

test("with no update every marker moves the learner, as before", () => {
  const followed = followTeachReplies(
    {
      sectionIndex: 0,
      taughtSectionIds: [],
      pending: [],
      lastUpdateAt: 0,
      sections: outline.sections,
    },
    [{ id: "m1", createdAt: 100, sectionId: "s2" }, { id: "m2", createdAt: 200, done: true }]
  )
  assert.equal(followed.sectionIndex, outline.sections.length)
})

test("replies are labelled as updated, new, or an earlier version", () => {
  const labels = teachReplyUpdateLabels(
    [
      { id: "old", createdAt: 100, sectionId: "s1" },
      { id: "fresh", createdAt: 700, sectionId: "s1" },
      { id: "added", createdAt: 800, sectionId: "u1n1" },
      { id: "other", createdAt: 900, sectionId: "s2" },
    ],
    [
      {
        at: 500,
        filenames: ["a.pdf"],
        summary: "",
        sections: [
          { id: "s1", change: "updated" },
          { id: "u1n1", change: "added" },
        ],
      },
    ]
  )
  assert.equal(labels.get("fresh"), "updated")
  assert.equal(labels.get("old"), "superseded")
  assert.equal(labels.get("added"), "added")
  assert.equal(labels.has("other"), false)
})

test("the divider names the file and counts the changes", () => {
  assert.equal(
    teachUpdateDividerText({
      at: 1,
      filenames: ["slides.pdf"],
      summary: "",
      sections: [
        { id: "s1", change: "updated" },
        { id: "n", change: "added" },
        { id: "m", change: "added" },
      ],
    }),
    "Lesson updated from slides.pdf. 1 section updated, 2 sections added."
  )
  assert.match(
    teachUpdateDividerText({ at: 1, filenames: ["a", "b"], summary: "", sections: [] }),
    /2 new files\. No sections needed changing/
  )
})

test("the analysis prompt sends the outline and new files, not the older material", () => {
  const prompt = buildTeachUpdatePrompt({
    moduleTitle: "DSA",
    unitTitle: "Unit 5",
    outline,
    taughtSectionIds: ["s1"],
    existingFilenames: ["canvas-page.md"],
    newSources: [{ filename: "slides.pdf", text: "UNIVERSAL HASHING TEXT" }],
  })
  assert.match(prompt, /canvas-page\.md/)
  assert.match(prompt, /UNIVERSAL HASHING TEXT/)
  assert.match(prompt, /"id":"s1","title":"What a hash table is".*"taught":true/)
  assert.match(prompt, /"id":"s2".*"taught":false/)
  assert.match(prompt, /untrusted reference material/)
})

test("a reply is checked before use, and a broken one is refused", () => {
  const parsed = parseTeachUpdateReply(
    JSON.stringify({
      summary: "  Adds   a topic. ",
      sections: [
        { id: " s1 ", title: "A", concepts: ["x", 5], change: "updated", note: "n" },
        { id: "s2", title: "", change: "updated" },
        { id: "s3", title: "B", change: "rewritten" },
        "nonsense",
      ],
    })
  )
  assert.equal(parsed.summary, "Adds a topic.")
  assert.deepEqual(parsed.sections, [
    { id: "s1", title: "A", concepts: ["x"], change: "updated", note: "n" },
  ])
  assert.throws(() => parseTeachUpdateReply('{"summary":"no list"}'), /section list/)
  assert.throws(() => parseTeachUpdateReply("not json"))
})

test("a structured reply is used when its text is not JSON", () => {
  const parsed = parseTeachUpdateReply({
    text: "Done.",
    output: { summary: "S", sections: [kept("s1", "A")] },
  })
  assert.equal(parsed.sections.length, 1)
})

test("a live session gets the update and only the new material", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "DSA",
    unitTitle: "Unit 5",
    sources: [{ filename: "old.md", text: "OLD MATERIAL" }],
    message: "Teach section 1",
    includeContext: false,
    update: {
      outline,
      summaries: ["The slides add universal hashing."],
      sources: [{ filename: "slides.pdf", text: "NEW SLIDE TEXT" }],
    },
  })
  assert.match(prompt, /LESSON UPDATE/)
  assert.match(prompt, /NEW SLIDE TEXT/)
  assert.match(prompt, /```outline/)
  assert.doesNotMatch(prompt, /OLD MATERIAL/)
})

test("a rebuilt session gets the notice without repeating the material", () => {
  const prompt = buildTeachPrompt({
    moduleTitle: "DSA",
    unitTitle: "Unit 5",
    sources: [{ filename: "slides.pdf", text: "NEW SLIDE TEXT" }],
    message: "Next section",
    includeContext: true,
    outline,
    update: {
      outline,
      summaries: ["The slides add universal hashing."],
      sources: [{ filename: "slides.pdf", text: "NEW SLIDE TEXT" }],
    },
  })
  assert.match(prompt, /LESSON UPDATE/)
  assert.equal(prompt.match(/NEW SLIDE TEXT/g)?.length, 1)
  assert.doesNotMatch(prompt, /NEW MATERIAL BEGIN/)
})
