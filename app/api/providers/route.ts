/** Reports local provider setup so pickers and save preflight can reject unavailable runtimes. */

import { PROVIDER_DEFINITIONS } from "@/lib/server/providers/registry"
import { changeProviderAuthentication } from "@/lib/server/providers/auth"
import { isAiProviderId } from "@/lib/ai-model-settings"
import { isTrustedBlitzOrigin } from "@/lib/server/request-origin"

/** Runs executable checks on the local Node.js host. */
export const runtime = "nodejs"

/** Checks configured providers without sending prompts or starting model sessions. */
export async function GET() {
  const providers = await Promise.all(
    PROVIDER_DEFINITIONS.map((provider) =>
      provider.checkAvailability({ workspaceDirectory: process.cwd() })
    )
  )
  return Response.json(providers, { headers: { "Cache-Control": "no-store" } })
}

/** Starts a user-requested provider login or clears one provider's local credentials. */
export async function POST(request: Request) {
  if (!isTrustedBlitzOrigin(request))
    return Response.json(
      { error: "Provider changes must come from this Blitz app." },
      { status: 403 }
    )
  let input: unknown
  try {
    input = await request.json()
  } catch {
    return Response.json(
      { error: "The provider request was invalid." },
      { status: 400 }
    )
  }
  if (typeof input !== "object" || input === null)
    return Response.json(
      { error: "The provider request was invalid." },
      { status: 400 }
    )
  const body = input as Record<string, unknown>
  if (
    typeof body.providerId !== "string" ||
    !isAiProviderId(body.providerId) ||
    (body.action !== "connect" &&
      body.action !== "disconnect" &&
      body.action !== "install")
  )
    return Response.json(
      { error: "The provider request was invalid." },
      { status: 400 }
    )
  try {
    await changeProviderAuthentication({
      providerId: body.providerId,
      action: body.action,
      workspaceDirectory: process.cwd(),
      ...(typeof body.methodId === "string" ? { methodId: body.methodId } : {}),
      ...(typeof body.account === "string" ? { account: body.account } : {}),
    })
    return Response.json({ ok: true })
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The provider could not complete the request.",
      },
      { status: 400 }
    )
  }
}
