/** Normalizes provider tool lifecycle frames into a bounded, user-safe activity record. */

/** Maximum number of tool records retained on one assistant message. */
export const MAX_PROVIDER_ACTIVITY_EVENTS = 64
/** Maximum visible title length retained from provider metadata. */
export const MAX_PROVIDER_ACTIVITY_TITLE = 120
/** Maximum optional detail length retained from provider metadata. */
export const MAX_PROVIDER_ACTIVITY_DETAIL = 500

/** Persisted tool lifecycle record shown beside an assistant response. */
export type ProviderActivityEvent = {
  id: string
  type: "tool"
  title: string
  status: "running" | "completed" | "failed"
  detail?: string
  startedAt?: number
  completedAt?: number
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
  detail?: unknown,
  startedAt?: number,
  completedAt?: number
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
    ...(typeof startedAt === "number" ? { startedAt } : {}),
    ...(typeof completedAt === "number" ? { completedAt } : {}),
  }
}

/** Extracts readable detail from tool input (commands, searches, file changes). */
function extractToolDetail(item: Record<string, unknown>): string | undefined {
  if (typeof item.command === "string" && item.command.trim()) {
    return item.command.trim()
  }
  if (typeof item.query === "string" && item.query.trim()) {
    return item.query.trim()
  }
  if (Array.isArray(item.queries) && item.queries.length > 0) {
    const qs = item.queries.filter(
      (q): q is string => typeof q === "string" && Boolean(q.trim())
    )
    if (qs.length > 0) return qs.join(", ")
  }
  if (typeof item.url === "string" && item.url.trim()) {
    return item.url.trim()
  }
  if (Array.isArray(item.changes) && item.changes.length > 0) {
    const paths = item.changes
      .map((c) => {
        if (typeof c === "string") return c
        if (typeof c === "object" && c !== null) {
          const p =
            (c as Record<string, unknown>).path ??
            (c as Record<string, unknown>).filePath
          return typeof p === "string" ? p : undefined
        }
        return undefined
      })
      .filter((p): p is string => Boolean(p?.trim()))
    if (paths.length > 0) return paths.join(", ")
  }
  if (typeof item.path === "string" && item.path.trim()) {
    return item.path.trim()
  }
  if (typeof item.file_path === "string" && item.file_path.trim()) {
    return item.file_path.trim()
  }
  if (typeof item.filePath === "string" && item.filePath.trim()) {
    return item.filePath.trim()
  }
  if (typeof item.filename === "string" && item.filename.trim()) {
    return item.filename.trim()
  }
  if (typeof item.pattern === "string" && item.pattern.trim()) {
    return item.pattern.trim()
  }
  const nested =
    record(item.input) ??
    record(item.arguments) ??
    record(item.params) ??
    record(item.action)
  if (nested) {
    return extractToolDetail(nested)
  }
  return undefined
}

/** Maps native tool names to concise, user-friendly action titles. */
function toolTitle(name: string): string {
  const lower = name.toLowerCase()
  if (/bash|command|terminal|exec/.test(lower)) return "Run command"
  if (/websearch|search.*web/.test(lower)) return "Search web"
  if (/search/.test(lower)) return "Search"
  if (/edit|write|replace|patch/.test(lower)) return "Edit file"
  if (/read|view/.test(lower)) return "Read file"
  if (/glob|grep/.test(lower)) return "Search files"
  if (/visit|fetch|browser|url/.test(lower)) return "Visit website"
  return name.replace(/([a-z])([A-Z])/g, "$1 $2")
}

/**
 * Reads one agent-engines tool or file event, as forwarded by
 * `providers/engine-turn.ts`, without its output.
 */
function engineActivity(
  method: string,
  params: Record<string, unknown>,
  previous: readonly ProviderActivityEvent[]
): ProviderActivityEvent | undefined {
  const id = text(params.itemId, 200)
  if (!id) return undefined
  const prev = previous.find((item) => item.id === id)
  const now = Date.now()
  if (method === "file/changed") {
    const paths = Array.isArray(params.changes)
      ? params.changes
          .map((change) => text(record(change)?.path, 300))
          .filter((path): path is string => Boolean(path))
      : []
    return event(
      id,
      prev?.title ?? "Edit file",
      "completed",
      paths.join(", ") || prev?.detail,
      prev?.startedAt,
      now
    )
  }
  const tool = record(params.tool)
  const kind = text(tool?.kind, 40)
  const name = text(tool?.name, MAX_PROVIDER_ACTIVITY_TITLE) ?? "Tool"
  const title =
    prev?.title ??
    (kind === "command"
      ? "Run command"
      : kind === "web-search"
        ? "Search web"
        : kind === "mcp"
          ? "Tool"
          : toolTitle(name))
  const input = record(tool?.input)
  const detail = (input ? extractToolDetail(input) : undefined) ?? prev?.detail
  if (method === "tool/started")
    return event(id, title, "running", detail, prev?.startedAt ?? now)
  return event(
    id,
    title,
    params.isError === true ? "failed" : "completed",
    detail,
    prev?.startedAt,
    prev?.completedAt ?? now
  )
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
  const id = text(call.toolCallId ?? call.id, 200)
  if (!id) return undefined
  const prev = previous.find((item) => item.id === id)
  const state = status(
    call.status,
    kind === "tool_call" ? "running" : "completed"
  )
  const input = record(call.input) ?? record(call.rawInput)
  const detail =
    text(
      call.detail ?? call.subtitle ?? call.command,
      MAX_PROVIDER_ACTIVITY_DETAIL
    ) ??
    (input ? extractToolDetail(input) : undefined) ??
    prev?.detail
  const title = call.title ?? call.name ?? prev?.title ?? "Tool"
  const now = Date.now()
  const startedAt =
    prev?.startedAt ?? (kind === "tool_call" ? now : undefined)
  const completedAt =
    state === "running" ? undefined : (prev?.completedAt ?? now)
  return event(id, title, state, detail, startedAt, completedAt)
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
  if (
    method === "tool/started" ||
    method === "tool/completed" ||
    method === "file/changed"
  )
    return engineActivity(method, params, previous)
  return method === "session/update" ? acpActivity(params, previous) : undefined
}
