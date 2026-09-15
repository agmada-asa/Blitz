/** Provides the native HTTP adapter for account activity and AI settings. */

import {
  isAiProviderId,
  type AiModelSettings,
  type AiProviderId,
} from "../../lib/ai-model-settings"

/** A notification row returned by the bounded activity endpoint. */
export type MobileActivityRow = {
  readonly id: string
  readonly kind:
    "preparation" | "research" | "import" | "card-reply" | "workspace-reply"
  readonly title: string
  readonly detail: string
  readonly context: string | null
  readonly status: "queued" | "running" | "completed" | "failed"
  readonly stage: string
  readonly href: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly elapsedSince: number | null
  readonly elapsedMs: number
  readonly generatedItemCount: number | null
  readonly error: string | null
}

/** Groups active work and finished rows the same way as the web notification center. */
export type MobileActivitySnapshot = {
  readonly tasks: readonly MobileActivityRow[]
  readonly notifications: readonly MobileActivityRow[]
  readonly chatNotifications: readonly MobileActivityRow[]
}

/** Describes one provider runtime reported by the existing provider probe. */
export type MobileProviderAvailability = {
  readonly providerId: AiProviderId
  readonly providerInstanceId?: string
  readonly available: boolean
  readonly authenticated: boolean | null
  readonly authMethods?: readonly {
    readonly id: string
    readonly name: string
    readonly description?: string
    readonly type?: "agent" | "terminal"
  }[]
  readonly accounts?: readonly string[]
  readonly canDisconnect?: boolean
  readonly reason?: string
  readonly message: string
  readonly models?: readonly {
    readonly id: string
    readonly label: string
    readonly reasoningEfforts?: readonly string[]
  }[]
}

/** Error raised for unavailable or malformed account responses. */
export class AccountApiError extends Error {
  /** Creates a safe client-facing account error without retaining response bodies. */
  constructor(message: string) {
    super(message)
    this.name = "AccountApiError"
  }
}

const REQUEST_TIMEOUT_MS = 12_000

/** Normalizes and validates a user-configured Blitz server address. */
function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(normalized)) {
    throw new AccountApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  }
  return normalized
}

/** Returns true for a non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Fetches JSON with a bounded timeout and a safe error surface. */
async function requestJson(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
    })
    const text = await response.text()
    let value: unknown
    try {
      value = text ? JSON.parse(text) : undefined
    } catch {
      throw new AccountApiError("Server returned an unreadable response")
    }
    if (!response.ok) {
      const message =
        isRecord(value) && typeof value.error === "string"
          ? value.error
          : "Server request failed"
      throw new AccountApiError(message)
    }
    return value
  } catch (error) {
    if (error instanceof AccountApiError) throw error
    throw new AccountApiError("Could not reach the Blitz server")
  } finally {
    clearTimeout(timeout)
  }
}

/** Reads the server's bounded activity snapshot. */
export async function fetchActivity(
  baseUrl: string
): Promise<MobileActivitySnapshot> {
  const value = await requestJson(baseUrl, "/api/mobile/activity")
  if (
    !isRecord(value) ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.notifications) ||
    !Array.isArray(value.chatNotifications)
  ) {
    throw new AccountApiError("Server returned invalid activity data")
  }
  return value as unknown as MobileActivitySnapshot
}

/** Reads persisted AI settings, with null meaning the shared defaults are active. */
export async function fetchSettings(
  baseUrl: string
): Promise<AiModelSettings | null> {
  const value = await requestJson(baseUrl, "/api/mobile/settings")
  if (value !== null && !isRecord(value))
    throw new AccountApiError("Server returned invalid settings data")
  return value as AiModelSettings | null
}

/** Saves the complete validated AI settings atomically on the server. */
export async function saveSettings(
  baseUrl: string,
  settings: AiModelSettings
): Promise<AiModelSettings> {
  const value = await requestJson(baseUrl, "/api/mobile/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
  if (!isRecord(value))
    throw new AccountApiError("Server returned invalid saved settings")
  return value as unknown as AiModelSettings
}

/** Reads provider availability without returning credentials or secret material. */
export async function fetchProviderAvailability(
  baseUrl: string
): Promise<MobileProviderAvailability[]> {
  const value = await requestJson(baseUrl, "/api/providers")
  if (!Array.isArray(value))
    throw new AccountApiError("Server returned invalid provider data")
  return value.flatMap((provider) => {
    if (
      !isRecord(provider) ||
      typeof provider.providerId !== "string" ||
      !isAiProviderId(provider.providerId) ||
      typeof provider.available !== "boolean" ||
      (provider.authenticated !== true &&
        provider.authenticated !== false &&
        provider.authenticated !== null) ||
      typeof provider.message !== "string"
    )
      return []
    return [
      {
        providerId: provider.providerId,
        ...(typeof provider.providerInstanceId === "string"
          ? { providerInstanceId: provider.providerInstanceId }
          : {}),
        available: provider.available,
        authenticated: provider.authenticated,
        ...(Array.isArray(provider.authMethods)
          ? {
              authMethods: provider.authMethods.flatMap((method) =>
                isRecord(method) &&
                typeof method.id === "string" &&
                typeof method.name === "string"
                  ? [
                      {
                        id: method.id,
                        name: method.name,
                        ...(typeof method.description === "string"
                          ? { description: method.description }
                          : {}),
                        ...(method.type === "agent" ||
                        method.type === "terminal"
                          ? { type: method.type }
                          : {}),
                      },
                    ]
                  : []
              ),
            }
          : {}),
        ...(Array.isArray(provider.accounts)
          ? {
              accounts: provider.accounts
                .filter(
                  (account): account is string => typeof account === "string"
                )
                .slice(0, 20),
            }
          : {}),
        ...(provider.canDisconnect === true ? { canDisconnect: true } : {}),
        ...(typeof provider.reason === "string"
          ? { reason: provider.reason }
          : {}),
        message: provider.message,
        ...(Array.isArray(provider.models)
          ? {
              models: provider.models.flatMap((model) =>
                isRecord(model) &&
                typeof model.id === "string" &&
                typeof model.label === "string"
                  ? [
                      {
                        id: model.id,
                        label: model.label,
                        ...(Array.isArray(model.reasoningEfforts)
                          ? {
                              reasoningEfforts: model.reasoningEfforts.filter(
                                (effort): effort is string =>
                                  typeof effort === "string"
                              ),
                            }
                          : {}),
                      },
                    ]
                  : []
              ),
            }
          : {}),
      } as MobileProviderAvailability,
    ]
  })
}

/** Sends one explicit provider connect, install, or disconnect action. */
export async function changeProviderConnection(
  baseUrl: string,
  input: {
    readonly providerId: AiProviderId
    readonly action: "connect" | "disconnect" | "install"
    readonly methodId?: string
    readonly account?: string
  }
): Promise<void> {
  await requestJson(baseUrl, "/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}
