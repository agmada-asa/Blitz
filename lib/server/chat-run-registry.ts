/** Tracks active workspace chat provider runs so a later pause request can cancel the exact turn. */

type ChatRunKey = `${string}:${string}`

export type ChatRunRegistration = {
  readonly chatId: string
  readonly messageId: string
  readonly signal: AbortSignal
  readonly expiresAt: number
}

type ActiveRun = ChatRunRegistration & {
  readonly controller: AbortController
  readonly finished: Promise<void>
  readonly finish: () => void
}

const REGISTRY_KEY = Symbol.for("blitz.chat-run-registry")
type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<ChatRunKey, ActiveRun>
}

/** Returns the HMR-stable process-local active run registry. */
function registry(): Map<ChatRunKey, ActiveRun> {
  const target = globalThis as GlobalWithRegistry
  return (target[REGISTRY_KEY] ??= new Map())
}

/** Creates the exact composite identity used to isolate one chat assistant run. */
function key(chatId: string, messageId: string): ChatRunKey {
  return `${chatId}:${messageId}`
}

/** Removes expired registrations and aborts their provider controllers. */
function removeExpired(now = Date.now()): void {
  for (const [entryKey, run] of registry()) {
    if (run.expiresAt <= now) {
      run.controller.abort()
      run.finish()
      registry().delete(entryKey)
    }
  }
}

/** Registers one active run and returns an exact identity cleanup callback. */
export function registerChatRun(
  chatId: string,
  messageId: string,
  controller: AbortController,
  expiresAt: number
): () => void {
  if (!chatId.trim() || !messageId.trim())
    throw new Error("Chat run identity is required")
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
    throw new Error("Chat run expiry is invalid")
  removeExpired()
  const runKey = key(chatId, messageId)
  if (registry().has(runKey)) throw new Error("Chat run is already active")
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  registry().set(runKey, {
    chatId,
    messageId,
    signal: controller.signal,
    expiresAt,
    controller,
    finished,
    finish,
  })
  return () => {
    finish()
    const current = registry().get(runKey)
    if (current?.controller === controller) registry().delete(runKey)
  }
}

/** Aborts exactly one active run, returning false for an unknown or expired identity. */
export function pauseChatRun(chatId: string, messageId: string): boolean {
  removeExpired()
  const runKey = key(chatId, messageId)
  const run = registry().get(runKey)
  if (!run) return false
  run.controller.abort()
  registry().delete(runKey)
  return true
}

/** Aborts one active run and awaits its background cleanup or a maximum timeout. */
export async function pauseAndAwaitChatRun(
  chatId: string,
  messageId: string,
  timeoutMs = 2_500
): Promise<boolean> {
  removeExpired()
  const runKey = key(chatId, messageId)
  const run = registry().get(runKey)
  if (!run) return false
  run.controller.abort()
  if (timeoutMs > 0) {
    await Promise.race([
      run.finished,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }
  registry().delete(runKey)
  return true
}

/** Reports whether the exact run identity is currently registered. */
export function hasChatRun(chatId: string, messageId: string): boolean {
  removeExpired()
  return registry().has(key(chatId, messageId))
}
