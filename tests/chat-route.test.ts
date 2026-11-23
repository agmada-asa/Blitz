/**
 * Runs whole turns through the workspace chat route (`app/api/chat/route.ts`):
 * each test posts a request to the real route and reads the streamed events
 * back, with the database, AI provider, and file storage replaced by the
 * stand-ins in `fixtures/chat-route-stubs.ts`. They pin down what the route
 * saves and sends, so its internals can be reorganised safely.
 */
import assert from "node:assert/strict"
import { access, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, beforeEach, test } from "node:test"

import { CardChatError } from "../lib/server/card-chat.ts"
import {
  resetChatRouteHarness,
  type ChatRouteHarness,
  type ProviderScript,
} from "./fixtures/chat-route-stubs.ts"

/** Modules the stand-ins replace when the route or its `chat-turn` helpers import them. */
const STUBBED = [
  "lib/server/convex.ts",
  "lib/server/providers/run-text-turn.ts",
  "lib/server/chat-agent.ts",
  "lib/server/chat-title.ts",
  "lib/server/providers/codex-models.ts",
  "lib/server/question-bank.ts",
  "lib/server/project-agent.ts",
  "lib/server/project-files.ts",
]

type RoutePost = (request: Request) => Promise<Response>

/**
 * Loads the route with its `@/` imports resolved from the repository root and
 * its outside services swapped for the stand-ins. Other modules that import
 * the same services keep the real ones.
 */
async function loadRoute(): Promise<RoutePost> {
  type Context = { conditions: string[]; parentURL?: string }
  type Result = { url: string; format?: string }
  const { registerHooks } = (await import("node:module")) as unknown as {
    registerHooks: (hooks: {
      resolve: (
        specifier: string,
        context: Context,
        next: (specifier: string, context: Context) => Result
      ) => Result
    }) => { deregister: () => void }
  }
  const root = new URL("../", import.meta.url)
  const routeUrl = new URL("app/api/chat/route.ts", root).href
  const stubsUrl = new URL("fixtures/chat-route-stubs.ts", import.meta.url).href
  const stubbedUrls = new Set(STUBBED.map((path) => new URL(path, root).href))
  const helpersUrl = new URL("lib/server/chat-turn/", root).href
  /** Whether a module is the route or one of its `chat-turn` helpers. */
  const routeSide = (url: string | undefined): boolean =>
    url === routeUrl || Boolean(url?.startsWith(helpersUrl))
  /** Tries a path with each source extension Next.js would accept. */
  const withExtensions = (
    base: string,
    context: Context,
    next: (specifier: string, context: Context) => Result
  ): Result | undefined => {
    for (const suffix of ["", ".ts", ".tsx", ".js", "/index.ts"]) {
      try {
        return next(base + suffix, context)
      } catch {
        /* Try the next extension. */
      }
    }
    return undefined
  }
  /** Resolves `@/` from the repository root and extensionless relative paths. */
  const resolveSource = (
    specifier: string,
    context: Context,
    next: (specifier: string, context: Context) => Result
  ): Result => {
    if (specifier.startsWith("@/")) {
      const found = withExtensions(
        new URL(specifier.slice(2), root).href,
        context,
        next
      )
      if (found) return found
    }
    try {
      return next(specifier, context)
    } catch (error) {
      if (specifier.startsWith(".")) {
        const found = withExtensions(specifier, context, next)
        if (found) return found
      }
      throw error
    }
  }
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const resolved = resolveSource(specifier, context, next)
      return routeSide(context.parentURL) && stubbedUrls.has(resolved.url)
        ? next(stubsUrl, context)
        : resolved
    },
  })
  try {
    return ((await import(routeUrl)) as { POST: RoutePost }).POST
  } finally {
    hooks.deregister()
  }
}

let POST: RoutePost
let directory: string
let harness: ChatRouteHarness

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-route-"))
  process.env.BLITZ_CODEX_WORKSPACE = join(directory, "chats")
  delete process.env.BLITZ_VOICE_MODEL
  POST = await loadRoute()
})

after(async () => {
  await rm(directory, { recursive: true, force: true })
})

const CHAT = "chat-1"
const REPLY = "reply-1"

/** What `workspaceChats:startTurn` returns for an ordinary next turn. */
function startedTurn(overrides: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    assistantMessageId: REPLY,
    providerId: "codex",
    providerSessionId: null,
    codexThreadId: null,
    shouldReplayContext: false,
    workspaceFolderId: null,
    fork: null,
    context: { compactFirst: false, restate: false },
    redo: null,
    providerHandoff: null,
    replyPrefix: "",
    replayContext: { messages: [], projectIds: [], attachments: [] },
    ...overrides,
  }
}

/** A Teach session on one unit with one source file and no outline yet. */
function teachContext(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    moduleTitle: "Computer Architecture",
    unitId: "unit-1",
    unitTitle: "Week 3",
    unitTitleSource: "auto",
    outline: null,
    sectionIndex: null,
    plan: null,
    planSaved: false,
    knownConcepts: { strong: [], shaky: [] },
    sources: [
      { id: "source-1", filename: "week3.pdf", text: "Caches keep hot data close.", truncated: false },
    ],
    turnInstruction: null,
    update: null,
    citationChunkIds: ["chunk-1"],
    citationFocus: null,
    referenceExcerpts: [],
    ...overrides,
  }
}

beforeEach(() => {
  harness = resetChatRouteHarness(join(directory, "projects"))
  harness.handlers = {
    "workspaceChats:get": () => ({}),
    "chatContext:getProjects": () => [],
    "settings:get": () => null,
    "workspaceChats:replySelection": () => null,
    "workspaceChats:startTurn": () => startedTurn(),
    "units:teachContext": () => null,
    "chatAgents:getSettings": () => ({
      autonomy: "approval",
      additionalInstructions: "",
      planFirst: false,
    }),
    "chatAgents:configure": () => ({ resetContext: false }),
    "chatCitations:projectPassages": () => ({ results: [] }),
    "chatCitations:prepare": () => [],
  }
})

/** Passes one provider event to the route. */
function emit(
  options: Parameters<ProviderScript>[1],
  event: Record<string, unknown>
): void {
  options.onEvent?.(event as never)
}

/** A provider attempt that starts a turn and streams `text` as its whole reply. */
function replies(
  text: string,
  {
    threadId = "thread-1",
    turnId = "turn-1",
    before = [],
  }: { threadId?: string; turnId?: string; before?: Record<string, unknown>[] } = {}
): ProviderScript {
  return async (_request, options) => {
    emit(options, { type: "turn-started", threadId, turnId })
    for (const event of before) emit(options, event)
    emit(options, { type: "text-delta", delta: text })
    return { threadId, turnId, text, durationMs: 5 }
  }
}

/** A provider attempt that fails before the runtime accepts the turn. */
function failsBeforeStart(error: Error): ProviderScript {
  return async () => {
    throw error
  }
}

/** Posts a chat request and reads every streamed event. */
async function post(
  body: Record<string, unknown> | string,
  headers: Record<string, string> = { origin: "http://localhost:3000" }
) {
  const response = await POST(
    new Request("http://localhost:3000/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  )
  const text = await response.text()
  const streamed = response.headers
    .get("content-type")
    ?.startsWith("application/x-ndjson")
  return {
    status: response.status,
    body: streamed ? undefined : (JSON.parse(text) as { error: string }),
    events: streamed
      ? text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [],
  }
}

/** A message in an existing chat. */
function message(overrides: Record<string, unknown> = {}) {
  return {
    chatId: CHAT,
    clientMessageId: "client-1",
    message: "What is a cache?",
    projectIds: [],
    attachments: [],
    ...overrides,
  }
}

/** Arguments of each call the route made to one Convex function. */
function calls(name: string): Record<string, unknown>[] {
  return harness.calls
    .filter((call) => call.name === name)
    .map((call) => call.args)
}

/** The streamed event types, in order. */
function types(events: Record<string, unknown>[]): unknown[] {
  return events.map((event) => event.type)
}

test("rejects requests from other sites and malformed JSON before starting a turn", async () => {
  const foreign = await post(message(), { origin: "https://example.com" })
  assert.equal(foreign.status, 400)
  assert.equal(foreign.body?.error, "Open Blitz to send a chat message")
  const malformed = await post("{not json")
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body?.error, "Chat request must be valid JSON")
  const empty = await post(message({ message: " " }))
  assert.equal(empty.status, 400)
  assert.equal(empty.body?.error, "Message is required")
  assert.deepEqual(harness.calls, [])
})

test("streams a new chat's reply, saves it, and names the chat", async () => {
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({ initialTitle: "What is a cache?" })
  harness.title = "Caches"
  harness.attempts = [
    async (_request, options) => {
      emit(options, { type: "turn-started", threadId: "thread-1", turnId: "turn-1" })
      emit(options, {
        type: "activity",
        notification: {
          method: "tool/started",
          params: { itemId: "tool-1", tool: { kind: "command", name: "shell", input: { command: "ls" } } },
        },
      })
      emit(options, { type: "thought-delta", delta: "Recall the notes." })
      emit(options, { type: "text-delta", delta: "A small, " })
      emit(options, { type: "text-delta", delta: "fast store." })
      return {
        threadId: "thread-1",
        turnId: "turn-1",
        text: "A small, fast store.",
        thought: "Recall the notes.",
        durationMs: 42,
      }
    },
  ]

  const { status, events } = await post(message({ chatId: undefined }))

  assert.equal(status, 200)
  assert.deepEqual(types(events), [
    "started",
    "activity",
    "thought-delta",
    "delta",
    "delta",
    "complete",
  ])
  assert.deepEqual(events[0], { type: "started", chatId: CHAT, messageId: REPLY })
  assert.deepEqual(events.at(-1), {
    type: "complete",
    chatId: CHAT,
    threadId: "thread-1",
    durationMs: 42,
  })

  const [start] = calls("workspaceChats:startTurn")
  assert.equal(start.message, "What is a cache?")
  assert.equal(start.clientMessageId, "client-1")
  assert.equal(start.chatId, undefined)
  assert.equal(start.providerId, "codex")

  const [request] = harness.requests
  assert.equal(harness.requests.length, 1)
  assert.match(request.prompt, /What is a cache\?/)
  assert.match(request.prompt, /No course passages are attached to this turn/)
  assert.equal(request.threadId, undefined)
  assert.equal(request.sandbox, "read-only")
  assert.equal(request.approvalPolicy, "on-request")
  assert.equal(request.workspaceDirectory, join(directory, "chats", CHAT))
  assert.equal(request.developerInstructions, `Work in ${join(directory, "chats", CHAT)}.`)
  assert.equal(harness.agentSessions[0].autonomy, "approval")

  assert.deepEqual(calls("workspaceChats:bindTurn"), [
    {
      chatId: CHAT,
      messageId: REPLY,
      providerId: "codex",
      providerSessionId: "thread-1",
      providerTurnId: "turn-1",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    },
  ])
  assert.deepEqual(calls("workspaceChats:complete"), [
    {
      chatId: CHAT,
      messageId: REPLY,
      providerId: "codex",
      providerSessionId: "thread-1",
      providerTurnId: "turn-1",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      reply: "A small, fast store.",
      thought: "Recall the notes.",
      durationMs: 42,
    },
  ])
  const savedEvents = calls("workspaceChats:saveProviderEvents")
  assert.ok(savedEvents.length >= 1)
  assert.deepEqual(
    (savedEvents.at(-1)!.events as { id: string; title: string }[]).map(
      ({ id, title }) => ({ id, title })
    ),
    [{ id: "tool-1", title: "Run command" }]
  )
  assert.deepEqual(calls("workspaceChats:setGeneratedTitle"), [
    { chatId: CHAT, title: "Caches", expectedCurrentTitle: "What is a cache?" },
  ])
  assert.deepEqual(calls("workspaceChats:fail"), [])
})

test("resumes the saved session, and replays the transcript when the session is gone", async () => {
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({
      providerSessionId: "thread-old",
      replayContext: {
        messages: [
          { role: "user", content: "Define latency.", status: "completed" },
          { role: "assistant", content: "Time to first byte.", status: "completed" },
        ],
        projectIds: [],
        attachments: [],
      },
    })
  harness.attempts = [
    failsBeforeStart(new CardChatError("transport", "Thread not found")),
    replies("Fresh answer.", { threadId: "thread-new" }),
  ]

  const { events } = await post(message())

  assert.equal(events.at(-1)?.type, "complete")
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.requests[0].threadId, "thread-old")
  assert.doesNotMatch(harness.requests[0].prompt, /Define latency/)
  assert.equal(harness.requests[1].threadId, undefined)
  assert.match(harness.requests[1].prompt, /Define latency\./)
  assert.match(harness.requests[1].prompt, /Time to first byte\./)
  assert.equal(calls("workspaceChats:complete")[0].providerSessionId, "thread-new")
})

test("a branch copies its source session, and replays quietly when the copy fails", async () => {
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({
      fork: { sessionId: "thread-source", throughTurnId: "turn-9" },
      shouldReplayContext: true,
      replayContext: {
        messages: [{ role: "user", content: "Earlier question.", status: "completed" }],
        projectIds: [],
        attachments: [],
      },
    })
  harness.attempts = [
    failsBeforeStart(new Error("Turn id is from an older runtime")),
    replies("Answer."),
  ]

  const { events } = await post(message())

  assert.deepEqual(harness.requests[0].fork, {
    threadId: "thread-source",
    throughTurnId: "turn-9",
  })
  assert.doesNotMatch(harness.requests[0].prompt, /Earlier question/)
  assert.equal(harness.requests[1].fork, undefined)
  assert.match(harness.requests[1].prompt, /Earlier question\./)
  assert.equal(events.at(-1)?.type, "complete")
  assert.deepEqual(calls("workspaceChats:fail"), [])
})

test("a reply that runs out of room is compacted and finished once", async () => {
  harness.attempts = [
    async (_request, options) => {
      emit(options, { type: "turn-started", threadId: "thread-1", turnId: "turn-1" })
      emit(options, { type: "text-delta", delta: "Part one, " })
      throw new CardChatError("context-window", "The conversation is too long.")
    },
    async (_request, options) => {
      emit(options, { type: "turn-started", threadId: "thread-1", turnId: "turn-2" })
      emit(options, { type: "compacted", origin: "requested", beforeTokens: 9000 })
      emit(options, { type: "text-delta", delta: "part two." })
      return { threadId: "thread-1", turnId: "turn-2", text: "part two." }
    },
  ]

  const { events } = await post(message())

  const [, continuation] = harness.requests
  assert.equal(continuation.threadId, "thread-1")
  assert.equal(continuation.compactFirst, true)
  assert.equal(continuation.attachments, undefined)
  assert.match(continuation.prompt, /^What is a cache\?/)
  assert.match(continuation.prompt, /PARTIAL REPLY END BEGIN\nPart one,\nPARTIAL REPLY END END/)
  assert.equal(continuation.compactedPrompt, continuation.prompt)
  assert.equal(calls("workspaceChats:complete")[0].reply, "Part one, part two.")
  // Compactions are recorded only for Teach sessions.
  assert.deepEqual(calls("workspaceChats:recordCompaction"), [])
  assert.equal(events.at(-1)?.type, "complete")
})

test("a failed reply is saved on the chat with its reason, after its notices", async () => {
  harness.attempts = [
    async (_request, options) => {
      emit(options, { type: "turn-started", threadId: "thread-1", turnId: "turn-1" })
      emit(options, {
        type: "notice",
        notice: { kind: "permission-denied", message: "Writing files is off." },
      })
      throw new CardChatError("usage-limit", "You've hit your usage limit.", new Error("429 from runtime"))
    },
  ]

  const { events } = await post(message())

  assert.deepEqual(types(events), ["started", "notice", "error"])
  assert.equal(events.at(-1)?.message, "You've hit your usage limit. Your chat context is saved.")
  assert.deepEqual(calls("workspaceChats:addNotice"), [
    {
      chatId: CHAT,
      messageId: REPLY,
      notice: { kind: "permission-denied", message: "Writing files is off." },
    },
  ])
  assert.deepEqual(calls("workspaceChats:fail"), [
    {
      chatId: CHAT,
      messageId: REPLY,
      error: "You've hit your usage limit. Your chat context is saved.",
      reason: "usage-limit",
      detail: "You've hit your usage limit.: 429 from runtime",
    },
  ])
  assert.deepEqual(calls("workspaceChats:complete"), [])
})

test("a failure before the turn starts is streamed but saves nothing", async () => {
  harness.handlers["workspaceChats:startTurn"] = () => {
    throw new Error("Chat is busy")
  }

  const { status, events } = await post(message())

  assert.equal(status, 200)
  assert.deepEqual(events, [
    { type: "error", message: "Blitz could not finish that reply. Try again." },
  ])
  assert.deepEqual(calls("workspaceChats:fail"), [])
  assert.deepEqual(harness.requests, [])
})

test("a send tied to a reply another tab moved past says so plainly", async () => {
  harness.handlers["workspaceChats:startTurn"] = () => {
    throw new Error("[CONVEX M(workspaceChats:startTurn)] Uncaught Error: This lesson has already moved on.")
  }

  const { events } = await post(message({ message: "Next section", after: "reply-3" }))

  assert.equal(calls("workspaceChats:startTurn")[0].after, "reply-3")
  assert.deepEqual(events, [{ type: "error", message: "This lesson has already moved on." }])
  assert.deepEqual(harness.requests, [])
})

test("project access is refused on a provider without a workspace sandbox", async () => {
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({ providerId: "claude-code" })

  const { events } = await post(
    message({ autonomy: "project", workingProjectId: "project-1" })
  )

  assert.equal(events.at(-1)?.type, "error")
  assert.deepEqual(harness.requests, [])
  assert.equal(calls("workspaceChats:fail")[0].reason, "transport")
  assert.equal(
    calls("workspaceChats:fail")[0].detail,
    "This provider has no workspace-only OS sandbox. Choose approval mode or full access."
  )
})

test("project access on Codex works in the project's folder with a workspace sandbox", async () => {
  harness.attempts = [replies("Done.")]

  await post(message({ autonomy: "project", workingProjectId: "project-1" }))

  const [request] = harness.requests
  assert.equal(request.sandbox, "workspace-write")
  assert.equal(request.workspaceDirectory, join(directory, "projects", "project-1"))
  assert.deepEqual(calls("chatAgents:configure")[0], {
    chatId: CHAT,
    autonomy: "project",
    additionalInstructions: "",
    workingProjectId: "project-1",
  })
  assert.equal(calls("projectAgents:syncArtifacts")[0].projectId, "project-1")
})

test("a spoken turn moves to the provider's fast model and asks for speakable replies", async () => {
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({ providerId: "claude-code" })
  harness.attempts = [replies("Short answer.")]

  await post(message({ spoken: true, voiceNote: "The learner is walking." }))

  const [request] = harness.requests
  assert.equal(request.model, "haiku")
  assert.equal(request.effort, undefined)
  assert.match(request.prompt, /This is a spoken conversation\./)
  assert.match(request.prompt, /Avoid Markdown/)
  assert.match(request.prompt, /The learner is walking\.$/)
})

test("an uploaded image is shown to the provider natively and copied into the chat folder", async () => {
  const token = "t".repeat(40)
  const png = new Uint8Array([137, 80, 78, 71])
  const stored = join(directory, "stored-diagram.png")
  await writeFile(stored, png)
  harness.handlers["chatCitations:getDocument"] = (args) =>
    args.documentId === "doc-1" && args.ownerToken === token
      ? {
          _id: "doc-1",
          filename: "diagram.png",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
          ownerToken: token,
          relativeKey: "uploads/diagram.png",
          text: "Diagram of a cache hierarchy",
        }
      : null
  const { chatStorageId } = await import("../lib/server/source-files.ts")
  harness.files.set(`${chatStorageId(token)}/uploads/diagram.png`, png)
  harness.filePaths.set(`${chatStorageId(token)}/uploads/diagram.png`, stored)
  harness.attempts = [replies("It shows L1 and L2.")]

  const { events } = await post(
    message({
      attachments: [
        { kind: "file", label: "upload", documentId: "doc-1", ownerToken: token },
      ],
    })
  )

  assert.equal(events.at(-1)?.type, "complete")
  const [request] = harness.requests
  assert.deepEqual(request.attachments, [
    {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from(png).toString("base64"),
      name: "diagram.png",
    },
  ])
  assert.match(request.prompt, /Diagram of a cache hierarchy/)
  const [saved] = calls("workspaceChats:startTurn")[0].attachments as Record<string, unknown>[]
  assert.equal(saved.label, "diagram.png")
  assert.equal(saved.mimeType, "image/png")
  await access(join(directory, "chats", CHAT, "attachments", "doc-1-diagram.png"))
})

test("a file the chat does not own stops the turn before it starts", async () => {
  harness.handlers["chatCitations:getDocument"] = () => null

  const { events } = await post(
    message({ attachments: [{ kind: "file", label: "secret.pdf", documentId: "doc-2" }] })
  )

  assert.deepEqual(events, [
    { type: "error", message: "Blitz could not finish that reply. Try again." },
  ])
  assert.deepEqual(calls("workspaceChats:startTurn"), [])
})

test("a Teach turn runs read-only on the unit, then records the outline it set", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({ shouldReplayContext: true })
  const reply = [
    "Here is the plan.",
    "```outline",
    JSON.stringify({ title: "Caches", sections: [{ id: "s1", title: "Why caches" }] }),
    "```",
  ].join("\n")
  harness.attempts = [
    async (_request, options) => {
      emit(options, { type: "turn-started", threadId: "thread-1", turnId: "turn-1" })
      emit(options, { type: "text-delta", delta: reply })
      return {
        threadId: "thread-1",
        turnId: "turn-1",
        text: reply,
        contextUsage: { usedTokens: 1000, windowTokens: 200000 },
      } as never
    },
  ]

  const { events } = await post(message({ message: "Start", autonomy: "full" }))

  assert.equal(events.at(-1)?.type, "complete")
  const [request] = harness.requests
  assert.equal(request.sandbox, "read-only")
  assert.equal(request.approvalPolicy, "never")
  assert.equal(request.readContextUsage, true)
  assert.equal(request.workspaceDirectory, join(directory, "projects", "project-1"))
  assert.match(request.prompt, /UNIT MATERIAL BEGIN\n[\s\S]*week3\.pdf[\s\S]*Caches keep hot data close\.[\s\S]*UNIT MATERIAL END/)
  // Agent settings from ordinary chats never reach Teach.
  assert.equal(harness.agentSessions[0].autonomy, "approval")
  assert.equal(harness.agentSessions[0].approvalPolicy, "never")
  assert.equal(calls("chatAgents:configure")[0].autonomy, "approval")
  // Teach cites the passages its context chose, not a project search.
  assert.deepEqual(calls("chatCitations:projectPassages"), [])
  assert.deepEqual(calls("chatCitations:prepare")[0].chunkIds, ["chunk-1"])

  const [context] = calls("workspaceChats:finishTurnContext")
  assert.equal(context.restated, true)
  assert.equal(context.updateDelivered, false)
  assert.deepEqual(
    { ...(context.usage as Record<string, unknown>), updatedAt: 0 },
    { usedTokens: 1000, windowTokens: 200000, updatedAt: 0 }
  )
  assert.deepEqual(calls("units:recordTeachProgress"), [
    {
      chatId: CHAT,
      outline: { title: "Caches", sections: [{ id: "s1", title: "Why caches" }] },
      unitTitle: "Week 3: Caches",
      coveredSourceIds: ["source-1"],
    },
  ])
  assert.deepEqual(harness.questionBanks, ["unit-1"])
})

test("Teach progress is saved before the reply completes, and only a planning reply sets the plan", async () => {
  const outline = {
    title: "Caches",
    sections: [
      { id: "s1", title: "Why caches" },
      { id: "s2", title: "Write policies" },
    ],
  }
  harness.handlers["units:teachContext"] = () => teachContext({ outline, sectionIndex: 0 })
  harness.handlers["teach:precheckResults"] = () => []
  harness.handlers["workspaceChats:startTurn"] = () => startedTurn({ providerSessionId: "thread-1" })
  const plan = '```plan\n{"s1":"skim","s2":"teach"}\n```'
  harness.attempts = [replies(plan), replies(`${plan}\n\`\`\`section\ns2\n\`\`\`\nWrite-back.`)]

  await post(message({ message: "Plan my lesson" }))
  await post(message({ message: "Next section" }))

  const names = harness.calls.map((call) => call.name)
  assert.ok(names.indexOf("units:recordTeachProgress") < names.indexOf("workspaceChats:complete"))
  const [planning, next] = calls("units:recordTeachProgress")
  assert.deepEqual(planning.plan, [
    { id: "s1", mode: "skim" },
    { id: "s2", mode: "teach" },
  ])
  // A plan block repeated in a teaching reply is ignored.
  assert.equal(next.plan, undefined)
  assert.equal(next.sectionId, "s2")
})

test("a Teach reply whose progress can't be saved fails instead of completing", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["units:recordTeachProgress"] = () => {
    throw new Error("Convex unreachable")
  }
  harness.attempts = [replies("```section\ns1\n```\nCaches.")]

  await post(message({ message: "Next section" }))

  assert.deepEqual(calls("workspaceChats:complete"), [])
  assert.equal(calls("workspaceChats:fail").length, 1)
})

test("a resumed Teach reply cites for the section it had opened", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({ providerSessionId: "thread-1", replyPrefix: "```section\ns2\n```\nWrite-back keeps" })
  harness.attempts = [replies(" dirty lines.")]

  await post(message({ message: "Continue", continuationOf: "reply-0" }))

  assert.equal(calls("units:teachContext")[0].resumedSectionId, "s2")
})

test("a long Teach session compacts first and restates the unit afterwards", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({
      providerSessionId: "thread-1",
      context: { compactFirst: true, restate: false },
    })
  harness.attempts = [
    replies("Next section.", {
      before: [{ type: "compacted", origin: "requested", beforeTokens: 150000 }],
    }),
  ]

  await post(message({ message: "Next section" }))

  const [request] = harness.requests
  assert.equal(request.threadId, "thread-1")
  assert.equal(request.compactFirst, true)
  assert.doesNotMatch(request.prompt, /UNIT MATERIAL BEGIN/)
  assert.match(request.compactedPrompt ?? "", /This session was just compacted/)
  assert.match(request.compactedPrompt ?? "", /UNIT MATERIAL BEGIN/)
  assert.deepEqual(calls("workspaceChats:recordCompaction"), [
    { chatId: CHAT, messageId: REPLY, origin: "auto", beforeTokens: 150000 },
  ])
  assert.equal(calls("workspaceChats:finishTurnContext")[0].restated, true)
})

test("a Teach redo rewinds the replaced turn and drops its reply", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({
      providerSessionId: "thread-1",
      redo: {
        beforeTurnId: "turn-4",
        replacedMessageIds: ["question-4", "reply-4"],
        originalMessage: "Explain write-back",
      },
    })
  harness.attempts = [
    replies("Simpler version.", { before: [{ type: "rewound", droppedTurns: 1 }] }),
  ]

  await post(
    message({ message: undefined, redo: { messageId: "reply-4", style: "simpler" } })
  )

  const [request] = harness.requests
  assert.equal(request.rewindBeforeTurnId, "turn-4")
  assert.match(request.prompt, /Explain write-back/)
  assert.equal(calls("workspaceChats:startTurn")[0].redoOf, "reply-4")
  assert.deepEqual(calls("workspaceChats:dropReplacedMessages"), [
    { chatId: CHAT, activeMessageId: REPLY, messageIds: ["question-4", "reply-4"] },
  ])
  assert.equal(calls("workspaceChats:complete")[0].reply, "Simpler version.")
})

test("a Teach redo of Next section asks for the section its reply taught", async () => {
  harness.handlers["units:teachContext"] = () => teachContext()
  harness.handlers["workspaceChats:startTurn"] = () =>
    startedTurn({
      providerSessionId: "thread-1",
      redo: {
        beforeTurnId: "turn-4",
        replacedMessageIds: ["question-4", "reply-4"],
        originalMessage: "Next section",
        tutorMessage: "Teach section 2: Write policies. Begin with a section block for s2 and follow the protocol. Teach it in full.",
      },
    })
  harness.attempts = [replies("Again.", { before: [{ type: "rewound", droppedTurns: 1 }] })]

  await post(message({ message: undefined, redo: { messageId: "reply-4", style: "simpler" } }))

  assert.match(harness.requests[0].prompt, /Teach section 2: Write policies/)
  assert.match(String(calls("units:teachContext")[0].message), /^Teach section 2:/)
})
