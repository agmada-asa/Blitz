/**
 * @file ocean-app/src/bridge.ts
 * @description The mini app's only connection to anything: JSON-RPC 2.0 messages to Ocean, the
 * shell it runs in on Allen's phone (an Android WebView) or Mac (a sandboxed iframe).
 * Method names follow MCP Apps (`ui/initialize`, `tools/call`, `ui/message`,
 * `ui/update-model-context`, `ui/open-link`); `ocean/activity` and the `ocean/changed`
 * notification are Ocean's own. Every tool call goes through Ocean to Blitz's MCP server
 * (`mcp/`), so Ocean can say who made each change and every open screen hears about it.
 */

/** What Ocean tells the app about where it is running. */
export interface HostContext {
  /** Ocean's current colour mode. */
  theme: "light" | "dark"
  /** Which Ocean shell the app is in. */
  platform: "phone" | "desktop"
  /** Route to open first, such as `module/<id>` or `review`; empty for the start screen. */
  route: string
}

/** One change made through Ocean, by Allen or an agent. */
export interface ActivityItem {
  /** ISO time of the change. */
  at: string
  /** Tool that made it. */
  tool: string
  /** Its arguments as JSON, clipped. */
  args: string
  /** "You", or the agent teammate's name. */
  who: string
  /** Title of the Ocean chat an agent made it in, when known. */
  entryTitle: string | null
  /** Whether the tool succeeded. */
  ok: boolean
}

declare global {
  interface Window {
    /** Present inside Ocean's Android WebView: posts one JSON message to the phone app. */
    OceanBridge?: { post(message: string): void }
    /** Called by the Android shell with each message for the app. */
    __oceanReceive?: (message: unknown) => void
  }
}

/** Parameters of a notification from Ocean, such as `{ theme }` or `{ route }`. */
export type NotificationParams = { theme?: string; route?: string } | undefined

/** A JSON-RPC message from Ocean: an answer to a request, or a notification. */
interface IncomingMessage {
  jsonrpc?: string
  id?: number
  result?: unknown
  error?: { message?: string }
  method?: string
  params?: NotificationParams
}

/** Longest the app waits for Ocean to answer one request, in milliseconds. */
const REQUEST_TIMEOUT_MS = 5 * 60_000

/** Requests waiting for an answer, by JSON-RPC id. */
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()

/** Listeners for notifications from Ocean. */
const listeners = new Set<
  (method: string, params: NotificationParams) => void
>()

let nextId = 1

/**
 * Sends one message to the shell.
 *
 * @param message JSON-RPC request or notification.
 */
function post(message: object): void {
  if (window.OceanBridge) {
    window.OceanBridge.post(JSON.stringify(message))
  } else {
    window.parent.postMessage(message, "*")
  }
}

/**
 * Handles one message from the shell: an answer to a request, or a notification.
 *
 * @param data The message, as an object or JSON text.
 */
function receive(data: unknown): void {
  let message = data as IncomingMessage | null

  if (typeof data === "string") {
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
  }

  if (!message || message.jsonrpc !== "2.0") {
    return
  }

  if (
    typeof message.id === "number" &&
    ("result" in message || "error" in message)
  ) {
    const waiting = pending.get(message.id)
    pending.delete(message.id)

    if (message.error) {
      waiting?.reject(new Error(message.error.message ?? "Ocean refused"))
    } else {
      waiting?.resolve(message.result)
    }

    return
  }

  if (typeof message.method === "string") {
    for (const listener of listeners) {
      listener(message.method, message.params)
    }
  }
}

window.addEventListener("message", (event) => {
  if (event.source === window.parent) {
    receive(event.data)
  }
})
window.__oceanReceive = receive

/**
 * Sends a request to Ocean and waits for its answer.
 *
 * @param method JSON-RPC method.
 * @param params Its parameters.
 * @param timeoutMs How long to wait before failing.
 * @returns The result.
 * @throws {Error} When Ocean refuses or does not answer in time.
 */
export function request<T>(
  method: string,
  params: object = {},
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const id = nextId++

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(
        new Error("Ocean didn't answer. Check that your Mac is connected.")
      )
    }, timeoutMs)

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    post({ jsonrpc: "2.0", id, method, params })
  })
}

/**
 * Listens for notifications from Ocean, such as `ocean/changed` and
 * `ui/notifications/host-context-changed`.
 *
 * @param listener Called with each notification's method and params.
 * @returns A function that stops listening.
 */
export function onNotification(
  listener: (method: string, params: NotificationParams) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Introduces the app to Ocean and reads the host context.
 *
 * @returns Where the app runs and what to open first.
 * @throws {Error} When the page is not running inside Ocean.
 */
export async function initialize(): Promise<HostContext> {
  const result = await request<{ hostContext?: Partial<HostContext> }>(
    "ui/initialize",
    { appInfo: { name: "Blitz", version: "1.0.0" }, appCapabilities: {} },
    5_000
  )
  const context = result.hostContext ?? {}

  return {
    theme: context.theme === "dark" ? "dark" : "light",
    platform: context.platform === "desktop" ? "desktop" : "phone",
    route: context.route ?? "",
  }
}

/**
 * Calls one Blitz tool through Ocean and parses its JSON result.
 *
 * @param name Tool name, as Blitz's MCP server lists it.
 * @param args Tool arguments.
 * @returns The tool's parsed JSON result.
 * @throws {Error} With the tool's own message when it fails.
 */
export async function callTool<T>(name: string, args: object = {}): Promise<T> {
  const result = await request<{
    content?: Array<{ text?: string }>
    isError?: boolean
  }>("tools/call", { name, arguments: args })
  const text = result.content?.[0]?.text ?? ""

  if (result.isError) {
    throw new Error(text || `${name} failed`)
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

/**
 * Tells Ocean what Allen is looking at, so a question asked next starts with it.
 *
 * @param text A short description with the ids an agent needs.
 */
export function setContext(text: string): void {
  request("ui/update-model-context", {
    content: [{ type: "text", text }],
  }).catch(() => {})
}

/**
 * Starts an Ocean chat with a request, prefixed with the current context. The answer arrives
 * in Ocean like any other chat; changes the agent makes show up here as they happen.
 *
 * @param text Allen's request.
 */
export async function askOcean(text: string): Promise<void> {
  await request("ui/message", {
    role: "user",
    content: [{ type: "text", text }],
  })
}

/**
 * Reads the changes made through Ocean, newest first.
 *
 * @param match Keeps only changes whose arguments mention this, such as a module id.
 * @returns Who changed what, and when.
 */
export async function activity(match?: string): Promise<ActivityItem[]> {
  const result = await request<{ items?: ActivityItem[] }>("ocean/activity", {
    match,
  })
  return result.items ?? []
}

/**
 * Opens a link outside the app: a website, an email address or a phone number.
 *
 * @param url `https:`, `mailto:` or `tel:` URL.
 */
export function openLink(url: string): void {
  request("ui/open-link", { url }).catch(() => {})
}
