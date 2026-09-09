/** Normalizes provider requests into safe composer controls and validates replies. */

import type {
  AgentRequestField,
  AgentRequestInput,
  AgentRequestKind,
  AgentRequestOption,
  AgentRequestQuestion,
} from "../agent-request.ts"
import type { CodexServerRequest } from "./codex-app-server.ts"
import type { CodexDynamicToolSpec } from "./codex-app-server.ts"
import {
  approvalRecord,
  projectApprovalDetails,
  supportedProjectApproval,
} from "./project-agent-approval.ts"

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

/** Returns the human-readable title used for known approval methods. */
export function agentRequestTitle(method: string): string {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return "Blitz wants to run a command"
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "Blitz wants to change files"
    case "item/permissions/requestApproval":
      return "Blitz needs more access"
    case "session/request_permission":
    case "claude/can_use_tool":
      return "Blitz wants to use a tool"
    case "item/tool/requestUserInput":
      return "Blitz needs your input"
    case "mcpServer/elicitation/request":
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
  try {
    displayDetails = requestDetails(JSON.parse(details))
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
  }
}

/** Converts an optional provider reason into short approval guidance. */
function approvalPrompt(
  method: string,
  params: Record<string, unknown>
): string {
  const reason = stringField(params, "reason")
  if (reason) return reason
  const command = stringField(params, "command")
  if (command) return `Review the command before allowing it to run.`
  if (method === "item/fileChange/requestApproval")
    return "Review the proposed file changes before allowing them."
  if (method === "item/permissions/requestApproval")
    return "Review the requested access before allowing it for this turn."
  return "Review this request before Blitz continues."
}

/** Normalizes a known Codex approval request into one composer card. */
function approvalRequest(
  request: CodexServerRequest,
  item?: unknown
): AgentRequestSpec {
  const params = approvalRecord(request.params) ?? {}
  return {
    method: request.method,
    kind: "approval",
    title: agentRequestTitle(request.method),
    details: projectApprovalDetails(request, item),
    prompt: approvalPrompt(request.method, params),
  }
}

/** Reads a Codex request_user_input question and its bounded options. */
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
      if (!label) throw new Error("Codex question option is invalid")
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
    ...(options ? { options } : {}),
  }
}

/** Normalizes Codex's structured question request for a composer form. */
function userInputRequest(request: CodexServerRequest): AgentRequestSpec {
  const params = approvalRecord(request.params)
  const rawQuestions = params?.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0)
    throw new Error("Codex user input request has no questions")
  if (rawQuestions.length > MAX_CONTROLS)
    throw new Error("Codex user input request has too many questions")
  const questions = rawQuestions.map(userInputQuestion)
  if (questions.some((question) => question === undefined))
    throw new Error("Codex user input request is invalid")
  return {
    method: request.method,
    kind: "question",
    title: agentRequestTitle(request.method),
    details: requestDetails({ request: request.params ?? {} }),
    prompt: "Answer these questions so Blitz can continue.",
    input: { questions: questions as AgentRequestQuestion[] },
  }
}

/** Reads the arguments from one app-server dynamic tool call. */
function dynamicToolArguments(
  request: CodexServerRequest
): Record<string, unknown> {
  const params = record(request.params)
  const args = record(params?.arguments)
  if (!args) throw new Error("Codex dynamic tool request has no arguments")
  return args
}

/** Converts a Blitz dynamic tool call into the same controls as native requests. */
function dynamicToolRequest(request: CodexServerRequest): AgentRequestSpec {
  const params = record(request.params)
  const tool = stringField(params, "tool")
  const args = dynamicToolArguments(request)
  if (tool === BLITZ_REQUEST_USER_INPUT_TOOL) {
    const spec = userInputRequest({
      ...request,
      method: request.method,
      params: args,
    })
    return {
      ...spec,
      title: "Blitz needs your input",
      details: requestDetails({ request: request.params ?? {} }),
    }
  }
  if (tool === BLITZ_REQUEST_APPROVAL_TOOL) {
    const prompt = stringField(args, "prompt")
    if (!prompt) throw new Error("Codex approval request has no prompt")
    return {
      method: request.method,
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
function mcpRequest(request: CodexServerRequest): AgentRequestSpec {
  const params = approvalRecord(request.params)
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
      method: request.method,
      kind: "url",
      title: agentRequestTitle(request.method),
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
    method: request.method,
    kind: "form",
    title: agentRequestTitle(request.method),
    details: requestDetails({ request: request.params ?? {} }),
    prompt: message,
    input: { ...inputBase, fields },
  }
}

/** Normalizes one supported Codex server request into a composer interaction. */
export function normalizeCodexAgentRequest(
  request: CodexServerRequest,
  item?: unknown
): AgentRequestSpec | undefined {
  if (supportedProjectApproval(request.method))
    return approvalRequest(request, item)
  if (request.method === "item/tool/requestUserInput")
    return userInputRequest(request)
  if (request.method === "mcpServer/elicitation/request")
    return mcpRequest(request)
  if (request.method === "item/tool/call") return dynamicToolRequest(request)
  return undefined
}

/** Builds the app-server response for a completed Blitz dynamic tool call. */
export function dynamicToolResponse(
  spec: AgentRequestSpec,
  accepted: boolean,
  serializedResponse?: string
): { contentItems: Array<{ type: "inputText"; text: string }>; success: true } {
  const result =
    spec.kind === "question"
      ? {
          accepted,
          ...userInputResponse(spec.input, accepted, serializedResponse),
        }
      : { accepted }
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
    success: true,
  }
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
  if (!Array.isArray(answers) || answers.length !== 1) return undefined
  const answer = responseString(answers[0])
  if (!answer) return undefined
  const values = question.options?.map((option) => option.value ?? option.label)
  if (values?.length && !values.includes(answer) && !question.isOther)
    return undefined
  return [answer]
}

/** Builds the protocol response for a Codex request_user_input decision. */
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

/** Builds the protocol response for an MCP form or URL decision. */
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
