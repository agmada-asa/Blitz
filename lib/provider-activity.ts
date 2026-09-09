/** Normalizes provider tool lifecycle frames into a bounded, user-safe activity record. */

/** Maximum number of tool records retained on one assistant message. */
export const MAX_PROVIDER_ACTIVITY_EVENTS = 64
/** Maximum visible title length retained from provider metadata. */
export const MAX_PROVIDER_ACTIVITY_TITLE = 120
/** Maximum optional detail length retained from provider metadata. */
export const MAX_PROVIDER_ACTIVITY_DETAIL = 240

/** Persisted tool lifecycle record shown beside an assistant response. */
export type ProviderActivityEvent = {
  id: string
  type: "tool"
  title: string
  status: "running" | "completed" | "failed"
  detail?: string
}

/** Accepts only plain object-shaped protocol records. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Returns nonempty bounded provider text, ignoring invalid values. */
function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined
  const result = value.trim()
  return result ? result.slice(0, maximum) : undefined
}

/** Maps native lifecycle statuses to the three display states. */
function status(
  value: unknown,
  fallback: ProviderActivityEvent["status"]
): ProviderActivityEvent["status"] {
  const normalized = text(value, 40)?.toLowerCase()
  if (normalized && /fail|error|cancel|reject/.test(normalized)) return "failed"
  if (normalized && /run|start|progress|pending|in_progress/.test(normalized))
    return "running"
  if (normalized && /complete|success|done|finish/.test(normalized))
    return "completed"
  return fallback
}

/** Builds one bounded activity record only when its identity and title are usable. */
function event(
  id: unknown,
  title: unknown,
  state: ProviderActivityEvent["status"],
  detail?: unknown
): ProviderActivityEvent | undefined {
  const safeId = text(id, 200)
  const safeTitle = text(title, MAX_PROVIDER_ACTIVITY_TITLE)
  if (!safeId || !safeTitle) return undefined
  const safeDetail = text(detail, MAX_PROVIDER_ACTIVITY_DETAIL)
  return {
    id: safeId,
    type: "tool",
    title: safeTitle,
    status: state,
    ...(safeDetail ? { detail: safeDetail } : {}),
  }
}

/** Extracts native Codex tool lifecycle metadata without raw output. */
function codexActivity(
  method: string,
  params: Record<string, unknown>
): ProviderActivityEvent | undefined {
  if (method !== "item/started" && method !== "item/completed") return undefined
  const item = record(params.item)
  if (!item) return undefined
  const kind = text(item.type, 80)
  if (!kind || !/command|tool|search|file|shell|mcp/i.test(kind))
    return undefined
  const command = text(item.command, MAX_PROVIDER_ACTIVITY_DETAIL)
  const title =
    text(item.title, MAX_PROVIDER_ACTIVITY_TITLE) ??
    (kind === "commandExecution"
      ? "Run command"
      : kind.replace(/([a-z])([A-Z])/g, "$1 $2"))
  const running = method === "item/started"
  return event(
    item.id,
    title,
    running ? "running" : status(item.status, "completed"),
    command
  )
}

/** Extracts Claude tool identity and completion without result content. */
function claudeActivity(
  method: string,
  params: Record<string, unknown>,
  previous: readonly ProviderActivityEvent[]
): ProviderActivityEvent | undefined {
  const block = record(params.block) ?? params
  if (method === "claude/tool_use" && block.type === "tool_use") {
    const input = record(block.input)
    return event(block.id, block.name, "running", input?.command)
  }
  if (method === "claude/tool_result" && block.type === "tool_result")
    return event(
      block.tool_use_id,
      previous.find((item) => item.id === block.tool_use_id)?.title ??
        "Tool result",
      block.is_error === true ? "failed" : "completed"
    )
  return undefined
}

/** Reads ACP tool updates while retaining the title from earlier partial updates. */
function acpActivity(
  params: Record<string, unknown>,
  previous: readonly ProviderActivityEvent[]
): ProviderActivityEvent | undefined {
  const update = record(params.update)
  if (!update) return undefined
  const kind = text(update.sessionUpdate, 80)
  if (kind !== "tool_call" && kind !== "tool_call_update") return undefined
  const call = record(update.toolCall) ?? update
  const state = status(
    call.status,
    kind === "tool_call" ? "running" : "completed"
  )
  const id = call.toolCallId ?? call.id
  return event(
    id,
    call.title ??
      call.name ??
      previous.find((item) => item.id === id)?.title ??
      "Tool",
    state
  )
}

/** Converts one normalized provider activity frame into a bounded persisted record. */
export function normalizeProviderActivity(
  input: unknown,
  previous: readonly ProviderActivityEvent[] = []
): ProviderActivityEvent | undefined {
  const frame = record(input)
  if (!frame || frame.type !== "activity") return undefined
  const notification = record(frame.notification)
  const method = text(frame.method ?? notification?.method, 100)
  const params = record(frame.params ?? notification?.params)
  if (!method || !params) return undefined
  return (
    codexActivity(method, params) ??
    claudeActivity(method, params, previous) ??
    (method === "session/update" ? acpActivity(params, previous) : undefined)
  )
}
