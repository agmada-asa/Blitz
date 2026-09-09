/** Defines the bounded request shapes shared by the chat UI and agent bridge. */

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
  status: "pending" | "approved" | "denied"
  /** Serialized user response retained only until the agent consumes it. */
  response?: string
}

/** Browser payload sent when a learner resolves one composer request. */
export type AgentRequestSubmission = {
  /** Whether the request was accepted or declined. */
  decision: "approved" | "denied"
  /** Serialized structured response for questions and forms. */
  response?: string
}

/** Reads structured controls without allowing malformed provider data to break the composer. */
export function parseAgentRequestInput(value?: string): AgentRequestInput {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    const input = parsed as Record<string, unknown>
    return {
      ...(Array.isArray(input.questions)
        ? { questions: input.questions as AgentRequestQuestion[] }
        : {}),
      ...(Array.isArray(input.fields)
        ? { fields: input.fields as AgentRequestField[] }
        : {}),
      ...(typeof input.url === "string" ? { url: input.url } : {}),
      ...(typeof input.serverName === "string"
        ? { serverName: input.serverName }
        : {}),
      ...(typeof input.message === "string" ? { message: input.message } : {}),
    }
  } catch {
    return {}
  }
}
