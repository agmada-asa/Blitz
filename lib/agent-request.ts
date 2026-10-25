/** Defines the bounded request shapes shared by the chat UI and agent bridge. */

/**
 * Method of a plan review: a project agent's plan, shown for approval before
 * it changes files when Plan first is on.
 */
export const PLAN_REQUEST_METHOD = "approval/plan"

/** Interaction modes that a provider can ask Blitz to present to a learner. */
export type AgentRequestKind = "approval" | "question" | "form" | "url"

/** One selectable value presented by a question or form field. */
export type AgentRequestOption = {
  /** Value submitted back to the provider when this option is chosen. */
  value?: string
  /** Short label shown beside the option. */
  label: string
  /** Optional explanation shown below the option label. */
  description?: string
}

/** One question requested by an agent tool. */
export type AgentRequestQuestion = {
  /** Stable provider-owned key used in the response map. */
  id: string
  /** Compact label used as the field legend. */
  header: string
  /** Full question shown to the learner. */
  question: string
  /** Whether the question accepts a typed "Other" answer. */
  isOther?: boolean
  /** Whether multiple displayed options may be selected. */
  multiSelect?: boolean
  /** Whether the answer should be obscured while it is entered. */
  isSecret?: boolean
  /** Optional single-select choices. */
  options?: AgentRequestOption[]
}

/** One field requested by an MCP form elicitation. */
export type AgentRequestField = {
  /** Provider-owned property name used in the submitted content object. */
  id: string
  /** Human-readable field label. */
  label: string
  /** Optional help text supplied by the provider. */
  description?: string
  /** Input control needed for the field. */
  type:
    "text" | "number" | "integer" | "boolean" | "single-select" | "multi-select"
  /** Whether the provider requires a non-empty value. */
  required?: boolean
  /** Whether typed text should be hidden. */
  secret?: boolean
  /** Optional select choices. */
  options?: AgentRequestOption[]
  /** Default value supplied by the provider. */
  defaultValue?: string | number | boolean | string[]
}

/** Structured controls carried by a persisted agent request. */
export type AgentRequestInput = {
  /** Safe local explanation when persisted controls are malformed or unsupported. */
  validationError?: string
  /** Exact native option identifiers for approval requests. */
  approvalOptions?: AgentRequestOption[]
  /** Questions for `item/tool/requestUserInput`. */
  questions?: AgentRequestQuestion[]
  /** Fields for an MCP form elicitation. */
  fields?: AgentRequestField[]
  /** URL opened for a URL-mode MCP elicitation. */
  url?: string
  /** Provider name to display when it is available. */
  serverName?: string
  /** Provider-supplied message associated with a form or URL. */
  message?: string
}

/** Persisted request data sent through the chat stream to the composer. */
export type AgentRequest = {
  /** Blitz-generated identifier used to correlate the browser decision. */
  id: string
  /** Provider request identifier, when the protocol exposes one. */
  providerRequestId?: string
  /** Provider protocol method that initiated the request. */
  method: string
  /** UI mode used to render the request. */
  kind: AgentRequestKind
  /** Short human-readable title. */
  title: string
  /** Raw bounded protocol data available in an expandable detail block. */
  details: string
  /** Optional direct instruction or explanation above the controls. */
  prompt?: string
  /** Serialized AgentRequestInput controls, when the request has structure. */
  input?: string
  /** Absolute expiry timestamp for the one-time request. */
  expiresAt: number
  /** Current persisted decision state. */
  status: "pending" | "approved" | "denied" | "expired" | "cancelled"
  /** Serialized user response retained only until the agent consumes it. */
  response?: string
  /** Timestamp when the request was initiated. */
  createdAt?: number
  /** Timestamp when the request was resolved or completed. */
  completedAt?: number
}

/** Browser payload sent when a learner resolves one composer request. */
export type AgentRequestSubmission = {
  /** Whether the request was accepted or declined. */
  decision: "approved" | "denied"
  /** Serialized structured response for questions and forms. */
  response?: string
}

/** Returns a plain data object from persisted JSON. */
function requestRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Guards bounded text before the UI calls string methods on provider data. */
function controlText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_000
}

/** Rejects keys with inherited-object semantics in form state maps. */
function controlId(value: unknown): value is string {
  return (
    controlText(value) &&
    !["__proto__", "prototype", "constructor"].includes(value)
  )
}

/** Validates every native choice without silently dropping an invalid option. */
function validOptions(value: unknown): value is AgentRequestOption[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    return false
  const seen = new Set<string>()
  return value.every((entry) => {
    const option = requestRecord(entry)
    if (
      !option ||
      !controlText(option.label) ||
      (option.value !== undefined && !controlText(option.value)) ||
      (option.description !== undefined && !controlText(option.description))
    )
      return false
    const id = typeof option.value === "string" ? option.value : option.label
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Checks a complete question, including flags that determine native answer semantics. */
function validQuestion(value: unknown): value is AgentRequestQuestion {
  const question = requestRecord(value)
  return Boolean(
    question &&
    controlId(question.id) &&
    controlText(question.header) &&
    controlText(question.question) &&
    ["isOther", "isSecret", "multiSelect"].every(
      (flag) =>
        question[flag] === undefined || typeof question[flag] === "boolean"
    ) &&
    (question.options === undefined || validOptions(question.options))
  )
}

/** Checks one supported flat form field; unknown schema types cannot become editable controls. */
function validField(value: unknown): value is AgentRequestField {
  const field = requestRecord(value)
  if (
    !field ||
    !controlId(field.id) ||
    !controlText(field.label) ||
    ![
      "text",
      "number",
      "integer",
      "boolean",
      "single-select",
      "multi-select",
    ].includes(String(field.type)) ||
    (field.options !== undefined && !validOptions(field.options)) ||
    ["required", "secret"].some(
      (flag) => field[flag] !== undefined && typeof field[flag] !== "boolean"
    )
  )
    return false
  const initial = field.defaultValue
  return (
    initial === undefined ||
    typeof initial === "string" ||
    typeof initial === "boolean" ||
    (typeof initial === "number" && Number.isFinite(initial)) ||
    (Array.isArray(initial) &&
      initial.length <= 32 &&
      initial.every(controlText))
  )
}

/** Validates bounded control lists and ensures response IDs cannot collide. */
function validControls<T extends { id: string }>(
  value: unknown,
  guard: (value: unknown) => value is T
): value is T[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(guard) &&
    new Set(value.map((control) => control.id)).size === value.length
  )
}

/** Reads structured controls atomically; malformed input yields a safe, non-actionable UI error. */
export function parseAgentRequestInput(value?: string): AgentRequestInput {
  if (!value) return {}
  const invalid = {
    validationError:
      "This request contains unsupported or invalid controls. Cancel it so the assistant can ask again.",
  }
  if (value.length > 20_000) return invalid
  try {
    const input = requestRecord(JSON.parse(value))
    if (
      !input ||
      (input.questions !== undefined &&
        !validControls(input.questions, validQuestion)) ||
      (input.fields !== undefined &&
        !validControls(input.fields, validField)) ||
      (input.approvalOptions !== undefined &&
        !validOptions(input.approvalOptions)) ||
      ["url", "serverName", "message"].some(
        (key) => input[key] !== undefined && !controlText(input[key])
      )
    )
      return invalid
    return {
      ...(input.approvalOptions
        ? { approvalOptions: input.approvalOptions as AgentRequestOption[] }
        : {}),
      ...(input.questions
        ? { questions: input.questions as AgentRequestQuestion[] }
        : {}),
      ...(input.fields ? { fields: input.fields as AgentRequestField[] } : {}),
      ...(typeof input.url === "string" ? { url: input.url } : {}),
      ...(typeof input.serverName === "string"
        ? { serverName: input.serverName }
        : {}),
      ...(typeof input.message === "string" ? { message: input.message } : {}),
    }
  } catch {
    return invalid
  }
}

/**
 * Extracts a readable command string from serialized approval details.
 *
 * Checks common structures such as `{ request: { command: "..." } }`,
 * `{ command: "..." }`, or `{ proposedExecpolicyAmendment: [...] }`.
 *
 * @param details - Raw serialized JSON details string from an approval request.
 * @returns The command string to display, or undefined if no command was found.
 */
export function extractApprovalCommand(details?: string): string | undefined {
  if (!details || !details.trim()) return undefined
  try {
    const data = JSON.parse(details) as unknown
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
    const record = data as Record<string, unknown>
    const candidates = [
      record,
      record.request,
      (record.request as Record<string, unknown> | undefined)?.params,
      record.params,
      record.proposedChange,
      (record.request as Record<string, unknown> | undefined)?.item,
    ]
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
        continue
      const obj = candidate as Record<string, unknown>
      if (typeof obj.command === "string" && obj.command.trim()) {
        return obj.command.trim()
      }
      if (
        Array.isArray(obj.proposedExecpolicyAmendment) &&
        obj.proposedExecpolicyAmendment.length > 0 &&
        obj.proposedExecpolicyAmendment.every((item) => typeof item === "string")
      ) {
        return obj.proposedExecpolicyAmendment.join(" ")
      }
    }
    if (
      Array.isArray(record.proposedExecpolicyAmendment) &&
      record.proposedExecpolicyAmendment.length > 0 &&
      record.proposedExecpolicyAmendment.every((item) => typeof item === "string")
    ) {
      return record.proposedExecpolicyAmendment.join(" ")
    }
  } catch {
    // Non-JSON details return undefined
  }
  return undefined
}

