"use client"

/**
 * Offers to carry a chat on with another signed-in provider when its own
 * provider stops at a usage limit, instead of sending the learner to
 * Settings. Shared by ordinary chats and Teach.
 *
 * Choosing a provider moves the chat onto it (`workspaceChats.handOff`), then
 * asks the screen to continue the stopped reply, which the chat route seeds
 * with the conversation so far.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { useMutation } from "convex/react"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import {
  handoffCandidates,
  providerLabel,
  type HandoffAvailability,
} from "@/lib/provider-handoff"
import type { AiProviderId } from "@/lib/ai-model-settings"

/** What the offer knows about the other providers while it checks them. */
type Candidates =
  | { readonly state: "checking" }
  | { readonly state: "ready"; readonly providers: readonly AiProviderId[] }
  | { readonly state: "failed" }

/**
 * Reads which other providers are installed and signed in.
 *
 * @param currentProviderId - Provider that hit its limit, left out.
 * @returns The check's progress and, once done, the providers to offer.
 */
function useHandoffCandidates(currentProviderId: string): Candidates {
  const [candidates, setCandidates] = useState<Candidates>({
    state: "checking",
  })
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/providers", { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Provider check failed")
        return response.json() as Promise<HandoffAvailability[]>
      })
      .then((providers) =>
        setCandidates({
          state: "ready",
          providers: handoffCandidates(currentProviderId, providers),
        })
      )
      .catch(() => {
        if (!controller.signal.aborted) setCandidates({ state: "failed" })
      })
    return () => controller.abort()
  }, [currentProviderId])
  return candidates
}

/**
 * The usage-limit card under a stopped reply.
 *
 * @param chatId - Chat whose provider stopped.
 * @param messageId - The stopped reply, which the new provider continues.
 * @param providerId - Provider that hit its limit.
 * @param disabled - True while another action runs on the chat.
 * @param onContinue - Continues the stopped reply once the chat has moved.
 */
export function ProviderHandoffOffer({
  chatId,
  messageId,
  providerId,
  disabled = false,
  onContinue,
}: {
  chatId: Id<"workspaceChats">
  messageId: Id<"workspaceChatMessages">
  providerId: string
  disabled?: boolean
  onContinue: () => Promise<void> | void
}) {
  const candidates = useHandoffCandidates(providerId)
  const handOff = useMutation(api.workspaceChats.handOff)
  const [pending, setPending] = useState<AiProviderId>()
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState("")
  const current = providerLabel(providerId)

  /** Moves the chat to one provider and continues the stopped reply there. */
  const continueWith = async (next: AiProviderId): Promise<void> => {
    setPending(next)
    setError("")
    try {
      await handOff({ chatId, messageId, providerId: next })
      await onContinue()
    } catch {
      setError(
        `This chat could not move to ${providerLabel(next)}. Try again.`
      )
    } finally {
      setPending(undefined)
    }
  }

  if (dismissed) return null
  const providers = candidates.state === "ready" ? candidates.providers : []
  const first = providers[0]
  return (
    <section
      aria-labelledby={`handoff-${messageId}`}
      className="mt-3 rounded-xl border border-border bg-muted/40 p-4 text-foreground"
    >
      <h3 id={`handoff-${messageId}`} className="text-sm font-medium">
        {current} has hit its usage limit
      </h3>
      <p className="mt-1 text-sm text-muted-foreground" role="status">
        {candidates.state === "checking"
          ? "Checking which other providers are signed in…"
          : first
            ? `${providerLabel(first)} can pick this chat up where it stopped. It gets the conversation so far, including what ${current} read from your sources.`
            : `No other provider is signed in. Wait for the reset, or connect one in Settings.`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {providers.map((next, index) => (
          <Button
            key={next}
            type="button"
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            disabled={disabled || pending !== undefined}
            onClick={() => void continueWith(next)}
          >
            {pending === next ? "Moving…" : `Continue with ${providerLabel(next)}`}
          </Button>
        ))}
        {candidates.state !== "checking" && !first ? (
          <Button asChild type="button" size="sm" variant="outline">
            <Link href="/settings">Open Settings</Link>
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending !== undefined}
          onClick={() => setDismissed(true)}
        >
          Wait for the reset
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}

/**
 * The line above a reply another provider took over, naming that provider.
 *
 * @param providerId - Provider that continued the reply.
 */
export function ContinuedWithNote({ providerId }: { providerId: string }) {
  return (
    <p className="mb-2 text-xs text-muted-foreground">
      Continued with {providerLabel(providerId)}
    </p>
  )
}
