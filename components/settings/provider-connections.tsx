"use client"

/** Lets people inspect, connect, refresh, and disconnect every local AI provider. */

import { Fragment, useCallback, useEffect, useState } from "react"

import { ProviderIcon } from "@/components/ai/provider-icons"
import { SpendingLimitSettings } from "@/components/settings/spending-limit-settings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { RefreshIcon } from "@/components/ui/icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { AI_PROVIDER_OPTIONS, type AiProviderId } from "@/lib/ai-model-settings"
import type { ProviderAvailability } from "@/lib/server/providers/types"

type ConnectionFeedback = { tone: "error" | "success"; message: string } | null

/** Returns the short status label and colour for one provider probe. */
function connectionBadge(provider: ProviderAvailability): {
  label: string
  variant: "default" | "secondary" | "destructive" | "outline"
} {
  if (!provider.available) return { label: "Not installed", variant: "outline" }
  if (provider.authenticated === true)
    return { label: "Connected", variant: "secondary" }
  if (provider.authenticated === false)
    return { label: "Needs sign in", variant: "destructive" }
  return { label: "Check required", variant: "outline" }
}

/** Renders provider account controls above the task-specific model settings. */
export function ProviderConnections() {
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(
    null
  )
  const [isRefreshing, setIsRefreshing] = useState(true)
  const [busyProvider, setBusyProvider] = useState<AiProviderId | null>(null)
  const [feedback, setFeedback] = useState<ConnectionFeedback>(null)
  const [disconnecting, setDisconnecting] =
    useState<ProviderAvailability | null>(null)
  const [selectedMethods, setSelectedMethods] = useState<
    Partial<Record<AiProviderId, string>>
  >({})
  const [selectedAccount, setSelectedAccount] = useState("")

  /** Refreshes all provider installation and credential states without caching them. */
  const refresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true)
    try {
      const response = await fetch("/api/providers", { cache: "no-store" })
      if (!response.ok) throw new Error("Could not check provider connections.")
      const next = (await response.json()) as ProviderAvailability[]
      setProviders(next)
      setSelectedMethods((current) => {
        const updated = { ...current }
        for (const provider of next)
          if (!updated[provider.providerId] && provider.authMethods?.[0])
            updated[provider.providerId] = provider.authMethods[0].id
        return updated
      })
      setFeedback(null)
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not check provider connections.",
      })
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/providers", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Could not check provider connections.")
        return (await response.json()) as ProviderAvailability[]
      })
      .then((next) => {
        setProviders(next)
        setSelectedMethods(
          Object.fromEntries(
            next.flatMap((provider) =>
              provider.authMethods?.[0]
                ? [[provider.providerId, provider.authMethods[0].id]]
                : []
            )
          )
        )
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setFeedback({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Could not check provider connections.",
        })
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsRefreshing(false)
      })
    return () => controller.abort()
  }, [])

  /** Sends a connect or disconnect request, then reads the provider state again. */
  const changeConnection = async (
    provider: ProviderAvailability,
    action: "connect" | "disconnect"
  ): Promise<void> => {
    setBusyProvider(provider.providerId)
    setFeedback(null)
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: provider.providerId,
          action,
          ...(action === "connect"
            ? { methodId: selectedMethods[provider.providerId] }
            : {}),
          ...(action === "disconnect" && selectedAccount
            ? { account: selectedAccount }
            : {}),
        }),
      })
      const result = (await response.json()) as { error?: string }
      if (!response.ok)
        throw new Error(
          result.error ?? "The provider could not complete the request."
        )
      setDisconnecting(null)
      setSelectedAccount("")
      await refresh()
      setFeedback({
        tone: "success",
        message:
          action === "connect"
            ? "Finish the provider sign in, then check again."
            : "Provider disconnected.",
      })
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The provider could not complete the request.",
      })
    } finally {
      setBusyProvider(null)
    }
  }

  return (
    <>
      <Card className="gap-0 py-0">
        <CardHeader className="flex-row items-start justify-between gap-4 border-b py-5">
          <div>
            <CardTitle>Provider connections</CardTitle>
            <CardDescription className="mt-1">
              Blitz checks the account used by each local provider runtime.
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isRefreshing || busyProvider !== null}
            onClick={() => void refresh()}
          >
            <RefreshIcon
              className={isRefreshing ? "animate-spin" : undefined}
            />
            Check again
          </Button>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {providers === null
            ? AI_PROVIDER_OPTIONS.map((provider) => (
                <div key={provider.id} className="space-y-2 px-4 py-5">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-4 w-full max-w-md" />
                </div>
              ))
            : AI_PROVIDER_OPTIONS.map((option) => {
                const provider = providers.find(
                  (item) => item.providerId === option.id
                )
                if (!provider) return null
                const badge = connectionBadge(provider)
                const methods = provider.authMethods ?? []
                const busy = busyProvider === provider.providerId
                const row = (
                  <div
                    key={provider.providerId}
                    className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ProviderIcon
                          provider={provider.providerId}
                          className="size-4"
                        />
                        <h3 className="text-sm font-medium">{option.label}</h3>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {provider.message}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                      {provider.available &&
                      provider.authenticated !== true &&
                      methods.length > 1 ? (
                        <Select
                          value={selectedMethods[provider.providerId]}
                          disabled={busy}
                          onValueChange={(value) =>
                            setSelectedMethods((current) => ({
                              ...current,
                              [provider.providerId]: value,
                            }))
                          }
                        >
                          <SelectTrigger
                            className="h-9 min-w-48"
                            aria-label={`${option.label} sign-in method`}
                          >
                            <SelectValue placeholder="Choose sign-in method" />
                          </SelectTrigger>
                          <SelectContent>
                            {methods.map((method) => (
                              <SelectItem key={method.id} value={method.id}>
                                {method.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {provider.available && provider.authenticated !== true ? (
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy || methods.length === 0}
                          onClick={() =>
                            void changeConnection(provider, "connect")
                          }
                        >
                          {busy ? "Connecting" : "Connect"}
                        </Button>
                      ) : null}
                      {provider.available &&
                      provider.authenticated === true &&
                      provider.canDisconnect ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => {
                            setSelectedAccount(provider.accounts?.[0] ?? "")
                            setDisconnecting(provider)
                          }}
                        >
                          Disconnect
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )
                // Only a per-token Claude Code sign-in can be capped.
                return provider.providerId === "claude-code" &&
                  provider.authenticated === true &&
                  provider.billing === "api-key" ? (
                  <Fragment key={provider.providerId}>
                    {row}
                    <SpendingLimitSettings />
                  </Fragment>
                ) : (
                  row
                )
              })}
        </CardContent>
        <p
          aria-live="polite"
          className={`border-t px-4 py-3 text-sm ${feedback?.tone === "error" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {feedback?.message ??
            "Connections stay on this device and are managed by each provider."}
        </p>
      </Card>

      <Dialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Disconnect{" "}
              {
                AI_PROVIDER_OPTIONS.find(
                  (item) => item.id === disconnecting?.providerId
                )?.label
              }
            </DialogTitle>
            <DialogDescription>
              This clears the provider&apos;s local credentials. Blitz will not
              be able to use it until you connect again.
            </DialogDescription>
          </DialogHeader>
          {disconnecting?.providerId === "opencode" &&
          (disconnecting.accounts?.length ?? 0) > 1 ? (
            <Select value={selectedAccount} onValueChange={setSelectedAccount}>
              <SelectTrigger aria-label="OpenCode account to disconnect">
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {disconnecting.accounts?.map((account) => (
                  <SelectItem key={account} value={account}>
                    {account}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={!disconnecting || busyProvider !== null}
              onClick={() =>
                disconnecting &&
                void changeConnection(disconnecting, "disconnect")
              }
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
