/**
 * Normalizes provider requests into safe composer controls and validates replies.
 *
 * Codex and Claude Code requests arrive as agent-engines `AgentRequest`s; ACP
 * requests and Blitz's own Codex dynamic tools arrive as native method and
 * params. Every path produces one {@link AgentRequestSpec} for the composer and
 * turns the learner's reply back into the exact answer the runtime expects.
 */

import type { AgentRequest, CodexToolCall } from "agent-engines"
import type {
  AgentRequestField,
  AgentRequestInput,
  AgentRequestKind,
  AgentRequestOption,
  AgentRequestQuestion,
} from "../agent-request.ts"

/** One native request handled by Blitz itself: a Codex dynamic tool call or an MCP elicitation. */
type NativeRequest = {
  /** Native request or call identifier, when the runtime supplied one. */
  readonly id?: string | number
  /** Native method or a Blitz label for the request family. */
  readonly method: string
  /** Untrusted native parameters. */
  readonly params?: unknown
}

/** A Codex host tool definition, as the app-server's `dynamicTools` expects it. */
export interface CodexDynamicToolSpec {
  /** Discriminator required by the app-server dynamic tool protocol. */
  type: "function"
  /** Stable tool name presented to the model. */
  name: string
  /** Plain-language guidance that tells the model when to call the tool. */
  description: string
  /** JSON Schema used to validate the model-supplied arguments. */
  inputSchema: Record<string, unknown>
}

/** Maximum raw request text retained in Convex or displayed in the composer. */
const MAX_REQUEST_DETAILS = 20_000
/** Maximum questions or form fields rendered for one request. */
const MAX_CONTROLS = 20
/** Maximum options rendered for one select control. */
const MAX_OPTIONS = 16

/** Dynamic tool used when a Codex chat needs an answer that should block the turn. */
export const BLITZ_REQUEST_USER_INPUT_TOOL = "blitz_request_user_input"
/** Dynamic tool used for an explicit user-requested checkpoint outside native OS approvals. */
export const BLITZ_REQUEST_APPROVAL_TOOL = "blitz_request_approval"

/** Returns fresh app-server tool definitions for interactive Blitz chat controls. */
export function codexAgentRequestTools(): CodexDynamicToolSpec[] {
  return [
    {
      type: "function",
      name: BLITZ_REQUEST_USER_INPUT_TOOL,
      description:
        "Ask the user one to three structured questions in the Blitz chat UI and wait for their answers. Use this instead of asking a normal text question when user input is required to continue.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "header", "question"],
              properties: {
                id: { type: "string", minLength: 1, maxLength: 80 },
                header: { type: "string", minLength: 1, maxLength: 80 },
                question: { type: "string", minLength: 1, maxLength: 500 },
                isOther: { type: "boolean" },
                isSecret: { type: "boolean" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: MAX_OPTIONS,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["label"],
                    properties: {
                      label: { type: "string", minLength: 1, maxLength: 120 },
                      description: {
                        type: "string",
                        minLength: 1,
                        maxLength: 300,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    {
      type: "function",
      name: BLITZ_REQUEST_APPROVAL_TOOL,
      description:
        "Ask the user for an explicit confirmation checkpoint and wait for approval or denial. Use this when the user asks you to seek approval before a step that would not otherwise trigger a native command, file, or permission approval.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          prompt: { type: "string", minLength: 1, maxLength: 4_000 },
          details: { type: "string", minLength: 1, maxLength: 8_000 },
        },
      },
    },
  ]
}

/** Provider-neutral request data used to create one persisted composer interaction. */
export type AgentRequestSpec = {
  /** Protocol method that initiated the request. */
  method: string
  /** Provider request identifier used to correlate native responses. */
  providerRequestId?: string
  /** Composer control family used for the request. */
  kind: AgentRequestKind
  /** Short title shown above the control. */
  title: string
  /** Raw bounded protocol data retained for inspection. */
  details: string
  /** Optional direct explanation shown above the controls. */
  prompt?: string
  /** Structured controls encoded into the persisted request. */
  input?: AgentRequestInput
}

/** Returns a non-array object from untrusted protocol data. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Returns a trimmed string field from an untrusted protocol record. */
function stringField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key]
  return typeof field === "string" && field.trim() ? field.trim() : undefined
}

/** Serializes request data while enforcing the existing review-size boundary. */
function requestDetails(value: unknown): string {
  const details = JSON.stringify(value, null, 2)
  if (!details || details.length > MAX_REQUEST_DETAILS)
    throw new Error(
      "This request is too large to review. Ask the agent to split it into smaller steps."
    )
  return details
}

/** Turns a protocol key into a readable field label when no title was supplied. */
function titleForKey(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase())
}

/** Method label persisted for an engine approval, by what the agent wants to do. */
const APPROVAL_METHODS: Readonly<Record<string, string>> = {
  command: "approval/command",
  "file-change": "approval/file-change",
  tool: "approval/tool",
  permissions: "approval/permissions",
}

/** Method label persisted for an engine question. */
const QUESTION_METHOD = "question"
/** Method label persisted for an MCP elicitation. */
const ELICITATION_METHOD = "elicitation"
/** Method label persisted for a Blitz dynamic tool call. */
const DYNAMIC_TOOL_METHOD = "tool/call"

/** Returns the human-readable title used for known request methods. */
export function agentRequestTitle(method: string): string {
  switch (method) {
    case "approval/command":
      return "Blitz wants to run a command"
    case "approval/file-change":
      return "Blitz wants to change files"
    case "approval/permissions":
      return "Blitz needs more access"
    case "approval/tool":
    case "session/request_permission":
      return "Blitz wants to use a tool"
    case QUESTION_METHOD:
      return "Blitz needs your input"
    case ELICITATION_METHOD:
      return "A connected tool needs your input"
    default:
      return "Blitz needs your decision"
  }
}

/** Creates a displayable approval request for native provider permission callbacks. */
export function genericApprovalRequest(
  method: string,
  details: string
): AgentRequestSpec {
  let displayDetails = details
  let approvalOptions: AgentRequestOption[] | undefined
  try {
    const parsed = JSON.parse(details) as unknown
    displayDetails = requestDetails(parsed)
    const params = record(parsed)
    if (Array.isArray(params?.options)) {
      const options = params.options.flatMap((value): AgentRequestOption[] => {
        const option = record(value)
        const id = stringField(option, "optionId")
        const label =
          stringField(option, "name") ?? stringField(option, "title") ?? id
        return id && label ? [{ value: id, label }] : []
      })
      if (options.length && options.length <= MAX_OPTIONS)
        approvalOptions = options
    }
  } catch {
    if (details.length > MAX_REQUEST_DETAILS)
      throw new Error(
        "This request is too large to review. Ask the agent to split it into smaller steps."
      )
  }
  return {
    method,
    kind: "approval",
    title: agentRequestTitle(method),
    details: displayDetails,
    prompt: "Review this request before Blitz continues.",
    ...(approvalOptions ? { input: { approvalOptions } } : {}),
  }
}

/** Runtime a request came from, which decides the grants Blitz may offer. */
export type AgentRequestProvider = "codex" | "claude" | "opencode"

/**
 * Returns whether an ACP permission request offers one kind of choice.
 *
 * @param raw - The request's native `session/request_permission` params.
 * @param kind - ACP option kind, such as `allow_once` or `allow_always`.
 */
function offersChoice(raw: unknown, kind: string): boolean {
  const options = record(raw)?.options
  return (
    Array.isArray(options) &&
    options.some((option) => record(option)?.kind === kind)
  )
}

/** Converts an optional runtime reason into short approval guidance. */
function approvalPrompt(
  request: Extract<AgentRequest, { kind: "approval" }>
): string {
  if (request.reason?.trim()) return request.reason.trim()
  if (request.command?.trim())
    return "Review the command before allowing it to run."
  if (request.action === "file-change")
    return "Review the proposed file changes before allowing them."
  if (request.action === "permissions")
    return "Review the requested access before allowing it for this turn."
  return "Review this request before Blitz continues."
}

/**
 * Normalizes one engine approval into one composer card. Codex file changes
 * must arrive with their proposed diff; an approval without one is refused,
 * since an opaque grant cannot be reviewed.
 */
function approvalRequest(
  request: Extract<AgentRequest, { kind: "approval" }>,
  provider: AgentRequestProvider
): AgentRequestSpec | undefined {
  if (
    provider === "codex" &&
    request.action === "file-change" &&
    !request.changes?.length
  )
    return undefined
  // Allowing must never fall through to an "always" grant, so OpenCode
  // requests without an allow-once choice are refused unseen.
  if (provider === "opencode" && !offersChoice(request.raw, "allow_once"))
    return undefined
  const method = APPROVAL_METHODS[request.action] ?? "approval/tool"
  return {
    method,
    kind: "approval",
    title: agentRequestTitle(method),
    details: requestDetails({
      request: request.raw ?? {},
      ...(request.command ? { command: request.command } : {}),
      ...(request.changes?.length
        ? { proposedChange: { changes: request.changes } }
        : {}),
    }),
    prompt: approvalPrompt(request),
    // A session grant stays inside Codex's own session. OpenCode keeps the
    // allow-always choice Blitz has always offered it. Claude would write a
    // grant to a settings file, which Blitz never does on the learner's behalf.
    ...((provider === "codex" &&
      (request.action === "command" || request.action === "file-change")) ||
    (provider === "opencode" && offersChoice(request.raw, "allow_always"))
      ? {
          input: {
            approvalOptions: [
              { value: "accept", label: "Allow once" },
              { value: "acceptForSession", label: "Allow for this session" },
            ],
          },
        }
      : {}),
  }
}

/** Reads one structured question and its bounded options. */
function userInputQuestion(value: unknown): AgentRequestQuestion | undefined {
  const question = record(value)
  const id = stringField(question, "id")
  const header = stringField(question, "header")
  const text = stringField(question, "question")
  if (!id || !header || !text) return undefined
  const rawOptions = question?.options
  let options: AgentRequestOption[] | undefined
  if (Array.isArray(rawOptions)) {
    if (rawOptions.length > MAX_OPTIONS) return undefined
    options = rawOptions.map((value) => {
      const option = record(value)
      const label = stringField(option, "label")
      const description = stringField(option, "description")
      if (!label) throw new Error("The agent's question option is invalid")
      return {
        value: label,
        label,
        ...(description ? { description } : {}),
      }
    })
  }
  return {
    id,
    header,
    question: text,
    ...(question?.isOther === true ? { isOther: true } : {}),
    ...(question?.isSecret === true ? { isSecret: true } : {}),
    ...(question?.multiSelect === true ? { multiSelect: true } : {}),
    ...(options ? { options } : {}),
  }
}

/** Normalizes a structured question request for a composer form. */
function userInputRequest(request: NativeRequest): AgentRequestSpec {
  const params = record(request.params)
  const rawQuestions = params?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0)
    throw new Error("The agent's question request has no questions")
  if (rawQuestions.length > MAX_CONTROLS)
    throw new Error("The agent asked too many questions at once")
  const questions = rawQuestions.map(userInputQuestion)
  if (questions.some((question) => question === undefined))
    throw new Error("The agent's question request is invalid")
  return {
    method: QUESTION_METHOD,
    kind: "question",
    title: agentRequestTitle(QUESTION_METHOD),
    details: requestDetails({ request: request.params ?? {} }),
    prompt: "Answer these questions so Blitz can continue.",
    input: { questions: questions as AgentRequestQuestion[] },
  }
}

/** Reads the arguments from one app-server dynamic tool call. */
function dynamicToolArguments(request: NativeRequest): Record<string, unknown> {
  const params = record(request.params)
  const args = record(params?.arguments)
  if (!args) throw new Error("Codex dynamic tool request has no arguments")
  return args
}

/** Converts a Blitz dynamic tool call into the same controls as native requests. */
function dynamicToolRequest(request: NativeRequest): AgentRequestSpec {
  const params = record(request.params)
  const tool = stringField(params, "tool")
  const args = dynamicToolArguments(request)
  if (tool === BLITZ_REQUEST_USER_INPUT_TOOL) {
    const spec = userInputRequest({ ...request, params: args })
    return {
      ...spec,
      method: DYNAMIC_TOOL_METHOD,
      title: "Blitz needs your input",
      details: requestDetails({ request: request.params ?? {} }),
    }
  }
  if (tool === BLITZ_REQUEST_APPROVAL_TOOL) {
    const prompt = stringField(args, "prompt")
    if (!prompt) throw new Error("Codex approval request has no prompt")
    return {
      method: DYNAMIC_TOOL_METHOD,
      kind: "approval",
      title: stringField(args, "title") ?? "Blitz needs your approval",
      prompt,
      details: stringField(args, "details") ?? prompt,
    }
  }
  throw new Error("Codex requested an unknown Blitz dynamic tool")
}

/** Extracts enum options from one MCP primitive schema. */
function schemaOptions(schema: Record<string, unknown>): AgentRequestOption[] {
  const rawEnum = schema.enum
  if (Array.isArray(rawEnum)) {
    if (
      rawEnum.length > MAX_OPTIONS ||
      rawEnum.some((value) => typeof value !== "string")
    )
      throw new Error("MCP form options are invalid")
    return rawEnum.map((value) => ({ value, label: value }))
  }
  const rawOneOf = schema.oneOf
  if (Array.isArray(rawOneOf)) {
    if (rawOneOf.length > MAX_OPTIONS)
      throw new Error("MCP form options are invalid")
    return rawOneOf.map((value) => {
      const option = record(value)
      const optionValue = option?.const
      const label = option?.title
      if (typeof optionValue !== "string" || typeof label !== "string")
        throw new Error("MCP form options are invalid")
      return { value: optionValue, label }
    })
  }
  return []
}

/** Converts one MCP requestedSchema property into a safe browser field. */
function formField(
  key: string,
  schema: Record<string, unknown>,
  required: boolean
): AgentRequestField {
  const schemaType = schema.type
  const label =
    typeof schema.title === "string" && schema.title.trim()
      ? schema.title.trim()
      : titleForKey(key)
  const description =
    typeof schema.description === "string" && schema.description.trim()
      ? schema.description.trim()
      : undefined
  const defaultValue = schema.default
  const common = {
    id: key,
    label,
    ...(description ? { description } : {}),
    ...(required ? { required: true } : {}),
    ...(schema.format === "password" ? { secret: true } : {}),
    ...(typeof defaultValue === "string" ||
    typeof defaultValue === "number" ||
    typeof defaultValue === "boolean" ||
    (Array.isArray(defaultValue) &&
      defaultValue.every((value) => typeof value === "string"))
      ? { defaultValue }
      : {}),
  }
  if (schemaType === "boolean") return { ...common, type: "boolean" }
  if (schemaType === "number") return { ...common, type: "number" }
  if (schemaType === "integer") return { ...common, type: "integer" }
  if (schemaType === "array") {
    const itemSchema = record(schema.items)
    const options = itemSchema ? schemaOptions(itemSchema) : []
    if (!options.length) throw new Error("MCP multi-select field is invalid")
    return { ...common, type: "multi-select", options }
  }
  const options = schemaOptions(schema)
  return options.length
    ? { ...common, type: "single-select", options }
    : { ...common, type: "text" }
}

/** Normalizes an MCP form schema into simple controls that Blitz can render. */
function mcpFields(schema: Record<string, unknown>): AgentRequestField[] {
  const properties = record(schema.properties)
  if (!properties) throw new Error("MCP form schema has no properties")
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (value): value is string => typeof value === "string"
      )
    : []
  const entries = Object.entries(properties)
  if (entries.length > MAX_CONTROLS)
    throw new Error("MCP form has too many fields")
  return entries.map(([key, value]) => {
    const fieldSchema = record(value)
    if (!fieldSchema) throw new Error("MCP form field is invalid")
    return formField(key, fieldSchema, required.includes(key))
  })
}

/** Accepts only browser-safe web URLs from URL-mode elicitation requests. */
function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

/** Normalizes an MCP form or URL elicitation request into composer controls. */
function mcpRequest(request: NativeRequest): AgentRequestSpec {
  const params = record(request.params)
  const message =
    stringField(params, "message") ?? "A connected tool needs information."
  const serverName = stringField(params, "serverName")
  const mode = stringField(params, "mode")
  const inputBase = {
    message,
    ...(serverName ? { serverName } : {}),
  }
  if (mode === "url") {
    const url = safeHttpUrl(stringField(params, "url") ?? "")
    if (!url) throw new Error("MCP URL request has no URL")
    return {
      method: ELICITATION_METHOD,
      kind: "url",
      title: agentRequestTitle(ELICITATION_METHOD),
      details: requestDetails({ request: request.params ?? {} }),
      prompt: message,
      input: { ...inputBase, url },
    }
  }
  if (mode !== "form" && mode !== "openai/form" && mode !== "openaiForm")
    throw new Error("MCP elicitation mode is not supported")
  const requestedSchema = record(params?.requestedSchema)
  const fields = requestedSchema ? mcpFields(requestedSchema) : []
  return {
    method: ELICITATION_METHOD,
    kind: "form",
    title: agentRequestTitle(ELICITATION_METHOD),
    details: requestDetails({ request: request.params ?? {} }),
    prompt: message,
    input: { ...inputBase, fields },
  }
}

/**
 * Normalizes one Codex, Claude Code or OpenCode request from agent-engines into a
 * composer interaction.
 *
 * @param request - Request event from the running turn.
 * @param provider - Runtime that raised it; session grants are offered on
 *   Codex and OpenCode only, and an OpenCode approval with no allow-once
 *   choice is refused unseen.
 * @returns The interaction, or undefined when Blitz refuses it unseen (an
 *   unreviewable file change). Throws when the request is too large or malformed.
 */
export function normalizeAgentRequest(
  request: AgentRequest,
  provider: AgentRequestProvider
): AgentRequestSpec | undefined {
  switch (request.kind) {
    case "approval":
      return approvalRequest(request, provider)
    case "question": {
      if (request.questions.length > MAX_CONTROLS)
        throw new Error("The agent asked too many questions at once")
      return userInputRequest({
        id: request.id,
        method: QUESTION_METHOD,
        params: {
          questions: request.questions.map((question) => ({
            id: question.id,
            header: question.header || question.question,
            question: question.question,
            ...(question.allowOther ? { isOther: true } : {}),
            ...(question.secret ? { isSecret: true } : {}),
            ...(question.multiSelect ? { multiSelect: true } : {}),
            ...(question.options.length
              ? {
                  options: question.options.map((option) => ({
                    label: option.label,
                    ...(option.description
                      ? { description: option.description }
                      : {}),
                  })),
                }
              : {}),
          })),
        },
      })
    }
    case "elicitation":
      return mcpRequest({
        id: request.id,
        method: ELICITATION_METHOD,
        params: {
          message: request.message,
          ...(request.server ? { serverName: request.server } : {}),
          mode: request.mode,
          ...(request.url ? { url: request.url } : {}),
          ...(request.schema !== undefined
            ? { requestedSchema: request.schema }
            : {}),
        },
      })
  }
}

/**
 * Answers one engine request with the learner's reviewed decision. Approvals
 * grant only what the composer showed: once, or for the Codex session when
 * that option was chosen. Malformed answers decline.
 *
 * @param request - Request event being answered.
 * @param spec - Interaction shown to the learner.
 * @param result - Learner's decision and serialized reply, if any.
 */
export async function answerAgentRequest(
  request: AgentRequest,
  spec: AgentRequestSpec,
  result: { accepted: boolean; response?: string }
): Promise<void> {
  switch (request.kind) {
    case "approval": {
      let optionId: string | undefined
      try {
        const parsed = result.response ? JSON.parse(result.response) : undefined
        optionId =
          typeof parsed?.optionId === "string" ? parsed.optionId : undefined
      } catch {
        optionId = undefined
      }
      await request.respond({
        decision: !result.accepted
          ? "deny"
          : optionId === "acceptForSession" &&
              spec.input?.approvalOptions?.some(
                (option) => option.value === "acceptForSession"
              )
            ? "allow-session"
            : "allow",
      })
      return
    }
    case "question": {
      const { answers } = userInputResponse(
        spec.input,
        result.accepted,
        result.response
      )
      await request.respond(
        Object.fromEntries(
          Object.entries(answers).map(([id, value]) => [id, value.answers])
        )
      )
      return
    }
    case "elicitation": {
      const answer = mcpElicitationResponse(
        spec,
        result.accepted,
        result.response
      )
      await request.respond({
        action: answer.action as "accept" | "decline" | "cancel",
        ...(record(answer.content) ? { content: record(answer.content) } : {}),
      })
      return
    }
  }
}

/** Refuses one engine request without showing it, using each kind's safe refusal. */
export async function refuseAgentRequest(request: AgentRequest): Promise<void> {
  if (request.kind === "approval") await request.respond({ decision: "deny" })
  else if (request.kind === "question") await request.respond({})
  else await request.respond({ action: "decline" })
}

/** Normalizes one Blitz dynamic tool call from Codex into a composer interaction. */
export function normalizeDynamicToolCall(call: CodexToolCall): AgentRequestSpec {
  return dynamicToolRequest({
    id: call.callId,
    method: DYNAMIC_TOOL_METHOD,
    params: { tool: call.tool, arguments: call.arguments },
  })
}

/** Builds the tool result returned to Codex for a completed Blitz dynamic tool call. */
export function dynamicToolResponse(
  spec: AgentRequestSpec,
  accepted: boolean,
  serializedResponse?: string
): { text: string; success: true } {
  const result =
    spec.kind === "question"
      ? {
          accepted,
          ...userInputResponse(spec.input, accepted, serializedResponse),
        }
      : { accepted }
  return { text: JSON.stringify(result), success: true }
}

/** Returns a string from a response object without accepting oversized values. */
function responseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 4_000 ? value : undefined
}

/** Validates and bounds one answer against the options shown to the learner. */
function questionAnswers(
  question: AgentRequestQuestion,
  value: unknown
): string[] | undefined {
  const answerRecord = record(value)
  const answers = answerRecord?.answers
  if (!Array.isArray(answers) || !answers.length) return undefined
  if (!question.multiSelect && answers.length !== 1) return undefined
  const selected = answers.map(responseString)
  if (selected.some((answer) => !answer)) return undefined
  const values = question.options?.map((option) => option.value ?? option.label)
  if (
    values?.length &&
    selected.some((answer) => !values.includes(answer!)) &&
    !question.isOther
  )
    return undefined
  return selected as string[]
}

/** Builds the answer map for a structured question decision; empty declines. */
export function userInputResponse(
  input: AgentRequestInput | undefined,
  accepted: boolean,
  serializedResponse?: string
): { answers: Record<string, { answers: string[] }> } {
  if (!accepted || !input?.questions?.length) return { answers: {} }
  let parsed: unknown
  try {
    parsed = serializedResponse ? JSON.parse(serializedResponse) : undefined
  } catch {
    return { answers: {} }
  }
  const answerMap = record(record(parsed)?.answers)
  if (!answerMap) return { answers: {} }
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of input.questions) {
    const values = questionAnswers(question, answerMap[question.id])
    if (!values) return { answers: {} }
    answers[question.id] = { answers: values }
  }
  return { answers }
}

/** Validates a single MCP form value against the control Blitz displayed. */
function formValue(
  field: AgentRequestField,
  value: unknown
): string | number | boolean | string[] | undefined {
  if (field.type === "boolean")
    return typeof value === "boolean" ? value : undefined
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    return field.type === "integer" && !Number.isInteger(value)
      ? undefined
      : value
  }
  if (field.type === "multi-select") {
    if (!Array.isArray(value)) return undefined
    const options = field.options?.map((option) => option.value ?? option.label)
    const values = value.filter(
      (entry): entry is string => typeof entry === "string"
    )
    return values.length === value.length &&
      (!options?.length || values.every((entry) => options.includes(entry)))
      ? values
      : undefined
  }
  if (typeof value !== "string") return undefined
  if (
    field.type === "single-select" &&
    field.options?.length &&
    !field.options.some((option) => (option.value ?? option.label) === value)
  )
    return undefined
  return value.length <= 4_000 ? value : undefined
}

/** Builds the answer for an MCP form or URL decision. */
export function mcpElicitationResponse(
  spec: AgentRequestSpec,
  accepted: boolean,
  serializedResponse?: string
): Record<string, unknown> {
  if (!accepted) return { action: "cancel" }
  if (spec.kind === "url") return { action: "accept" }
  let parsed: unknown
  try {
    parsed = serializedResponse ? JSON.parse(serializedResponse) : undefined
  } catch {
    return { action: "decline" }
  }
  const response = record(parsed)
  const content = record(response?.content)
  if (!content) return { action: "decline" }
  const fields = spec.input?.fields ?? []
  if (!fields.length) {
    const freeform = responseString(content.response)?.trim()
    return {
      action: "accept",
      content: freeform ? { response: freeform } : {},
    }
  }
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const value = formValue(field, content[field.id])
    if (value === undefined) {
      if (field.required) return { action: "decline" }
      continue
    }
    if (
      field.type !== "boolean" &&
      ((typeof value === "string" && value.trim() === "") ||
        (Array.isArray(value) && value.length === 0))
    ) {
      if (field.required) return { action: "decline" }
      continue
    }
    result[field.id] = value
  }
  return { action: "accept", content: result }
}
