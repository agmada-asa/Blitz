"use client"

/**
 * Renders the t3 code-styled model, reasoning effort, and access level picker bar.
 *
 * This component provides a unified segmented control bar containing:
 * - A Model trigger with provider brand icon that opens a two-pane Popover
 *   (left rail for Favorites and Providers; right pane for search, models, and legacy collapse).
 * - A Reasoning effort trigger that opens a dropdown for supported effort levels.
 * - An optional Access level trigger with lock icon that opens a dropdown for approval policies.
 */

import { providerAccessChoice } from "@/lib/provider-capabilities"
import { useCallback, useEffect, useMemo, useState } from "react"

import {
  ChevronDownIcon,
  ChevronRightIcon,
  LockIcon,
  ProviderIcon,
  SearchIcon,
  StarFilledIcon,
  StarOutlineIcon,
} from "@/components/ai/provider-icons"
import { useFavoriteModels } from "@/components/ai/use-favorite-models"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CheckIcon } from "@/components/ui/icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  AI_PROVIDER_APPROVAL_POLICIES,
  AI_PROVIDER_OPTIONS,
  getAiModelPickerOptions,
  getAiProviderOptionsForTask,
  getSupportedAiReasoningEffortsForProvider,
  isLegacyAiModelOption,
  type AiApprovalPolicy,
  type AiProviderModelOption,
  type AiProviderId,
  type AiReasoningEffort,
  type AiTask,
} from "@/lib/ai-model-settings"
import type { ProviderAvailability } from "@/lib/server/providers/types"
import { cn } from "@/lib/utils"

/** Props for the controlled model, reasoning, and access level picker. */
export type ModelReasoningPickerProps = {
  /** Provider integration currently selected for the task. */
  provider?: AiProviderId
  /** Task capability used to omit providers that cannot safely run this work. */
  task?: AiTask
  /** The model ID currently selected by the owning form. */
  model: string
  /** The reasoning level currently selected by the owning form. */
  reasoning: AiReasoningEffort
  /** Optional interactive chat access/approval policy currently selected. */
  accessPolicy?: AiApprovalPolicy
  /** Prevents opening or changing the picker while the owner is busy. */
  disabled?: boolean
  /** Receives the provider, model, and reasoning choice as one update. */
  onChange: (
    model: string,
    reasoning: AiReasoningEffort,
    provider: AiProviderId
  ) => void
  /** Receives an approval/access policy change when access level is shown. */
  onAccessPolicyChange?: (policy: AiApprovalPolicy) => void
  /** Whether to show the access policy selector (defaults to true when accessPolicy is provided). */
  showAccessPolicy?: boolean
  /** Names the task in the generated accessible label. */
  labelPrefix?: string
  /** Additional classes for the visible trigger bar container. */
  className?: string
  /** Accessible name for the combined control. */
  "aria-label"?: string
  /** Optional description reference for the combined control. */
  "aria-describedby"?: string
}

/** Formats a machine-readable effort value for the visible picker label. */
export function reasoningLabel(effort: AiReasoningEffort): string {
  if (effort === "default") return "Default"
  return effort === "xhigh"
    ? "Extra high"
    : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

/** Returns the label for the adapter's actual access policy. */
export function accessPolicyLabel(policy: AiApprovalPolicy, provider: AiProviderId = "codex"): string {
  return providerAccessChoice(provider, policy).label
}

/** Describes enforced access without implying unsupported sandboxing or automatic review. */
export function accessPolicyDescription(policy: AiApprovalPolicy, provider: AiProviderId = "codex"): string {
  return providerAccessChoice(provider, policy).description
}

/**
 * Renders the t3 code-styled segmented control bar with model popover, reasoning dropdown, and access policy.
 *
 * @param props - Controlled picker properties and event handlers.
 * @returns An interactive segmented button row and tethered popovers.
 */
export function ModelReasoningPicker({
  provider = "codex",
  task,
  model,
  reasoning,
  accessPolicy,
  disabled = false,
  onChange,
  onAccessPolicyChange,
  showAccessPolicy = Boolean(accessPolicy && onAccessPolicyChange),
  labelPrefix = "Model",
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: ModelReasoningPickerProps) {
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [selectedRailTab, setSelectedRailTab] = useState<string>(provider)
  const [searchQuery, setSearchQuery] = useState("")
  const [legacyExpanded, setLegacyExpanded] = useState(false)
  const [availability, setAvailability] = useState<ProviderAvailability[]>([])
  const [availabilityError, setAvailabilityError] = useState(false)
  const [probe, setProbe] = useState(0)

  const { favorites, isFavorite, toggleFavorite } = useFavoriteModels()

  /** Synchronizes rail selection and refreshes provider availability when opening the popover. */
  const handleOpenChange = (open: boolean): void => {
    setModelPickerOpen(open)
    if (open) {
      setSelectedRailTab(provider)
      setProbe((v) => v + 1)
      setSearchQuery("")
      setLegacyExpanded(false)
    }
  }

  // Probe provider health for setup guidance
  useEffect(() => {
    const controller = new AbortController()
    fetch("/api/providers", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Provider check failed")
        return response.json() as Promise<ProviderAvailability[]>
      })
      .then((providers) => {
        setAvailability(providers)
        setAvailabilityError(false)
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailabilityError(true)
      })
    return () => controller.abort()
  }, [probe])

  const providerOptions = task
    ? getAiProviderOptionsForTask(task)
    : AI_PROVIDER_OPTIONS

  /** Converts the latest provider probe into the shared picker option shape. */
  const runtimeModelOptions = useCallback(
    (
      providerId: AiProviderId
    ): readonly AiProviderModelOption[] | undefined => {
      const models = availability.find(
        (item) => item.providerId === providerId
      )?.models
      return models?.map((option) => ({
        id: option.id,
        label: option.label,
        reasoningEfforts:
          option.reasoningEfforts ??
          (option.reasoningEffort ? [option.reasoningEffort] : ["default"]),
        ...(option.inputModalities
          ? { inputModalities: option.inputModalities }
          : {}),
      }))
    },
    [availability]
  )

  const modelOptions = useMemo(
    () =>
      getAiModelPickerOptions(provider, model, runtimeModelOptions(provider)),
    [provider, model, runtimeModelOptions]
  )

  const selectedModel = modelOptions.find((option) => option.id === model)
  const selectedModelLabel = selectedModel?.label ?? model
  const selectedProviderLabel =
    AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ??
    provider

  const supportedReasoningEfforts = useMemo(
    () =>
      getSupportedAiReasoningEffortsForProvider(
        provider,
        model,
        runtimeModelOptions(provider)
      ),
    [provider, model, runtimeModelOptions]
  )

  const selectedReasoningLabel = reasoningLabel(reasoning)

  const supportedAccessPolicies = useMemo(() => {
    return AI_PROVIDER_APPROVAL_POLICIES[provider] ?? ["never"]
  }, [provider])

  /** Commits a model, its provider, and a compatible reasoning level as one selection. */
  const handleSelectModel = (
    chosenProvider: AiProviderId,
    chosenModelId: string
  ): void => {
    if (disabled) return
    const nextEfforts = getSupportedAiReasoningEffortsForProvider(
      chosenProvider,
      chosenModelId,
      runtimeModelOptions(chosenProvider)
    )
    const nextReasoning = nextEfforts.includes(reasoning)
      ? reasoning
      : (nextEfforts[0] ?? "medium")

    onChange(chosenModelId, nextReasoning, chosenProvider)
    setModelPickerOpen(false)
  }

  // Aggregate models for the right panel based on selected rail tab
  type EnrichedModel = {
    id: string
    label: string
    provider: AiProviderId
    providerLabel: string
    isLegacy: boolean
  }

  const displayedModels: EnrichedModel[] = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    if (selectedRailTab === "favorites") {
      // Gather favorited models from all available task providers
      const all: EnrichedModel[] = []
      for (const p of providerOptions) {
        // Only pass the active model to its owning provider so foreign providers do not inherit it as a saved model
        const activeModelForProvider = p.id === provider ? model : ""
        const opts = getAiModelPickerOptions(
          p.id,
          activeModelForProvider,
          runtimeModelOptions(p.id)
        )
        for (const opt of opts) {
          if (
            favorites.includes(opt.id) &&
            !all.some(
              (existing) => existing.id === opt.id && existing.provider === p.id
            )
          ) {
            all.push({
              id: opt.id,
              label: opt.label,
              provider: p.id,
              providerLabel: p.label,
              isLegacy: isLegacyAiModelOption(p.id, opt, opts),
            })
          }
        }
      }
      if (!query) return all
      return all.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query) ||
          m.providerLabel.toLowerCase().includes(query)
      )
    }

    // Provider-specific view
    const pId = selectedRailTab as AiProviderId
    const pOpt = AI_PROVIDER_OPTIONS.find((o) => o.id === pId)
    const opts = getAiModelPickerOptions(
      pId,
      pId === provider ? model : "",
      runtimeModelOptions(pId)
    )
    const enriched = opts.map((opt) => ({
      id: opt.id,
      label: opt.label,
      provider: pId,
      providerLabel: pOpt?.label ?? pId,
      isLegacy: isLegacyAiModelOption(pId, opt, opts),
    }))

    if (!query) return enriched
    return enriched.filter(
      (m) =>
        m.label.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query)
    )
  }, [
    selectedRailTab,
    providerOptions,
    provider,
    model,
    favorites,
    searchQuery,
    runtimeModelOptions,
  ])

  const modernModels = useMemo(
    () => displayedModels.filter((m) => !m.isLegacy),
    [displayedModels]
  )

  const legacyModels = useMemo(
    () => displayedModels.filter((m) => m.isLegacy),
    [displayedModels]
  )

  const selectedModelIsLegacy = legacyModels.some(
    (item) => item.id === model && item.provider === provider
  )
  const showLegacyModels = legacyExpanded || selectedModelIsLegacy

  const accessibleLabel = `${labelPrefix} ${selectedProviderLabel}, ${selectedModelLabel}, ${selectedReasoningLabel} reasoning${
    accessPolicy
      ? `, ${accessPolicyLabel(accessPolicy, provider)} access`
      : ""
  }`

  return (
    <div
      aria-label={ariaLabel ?? accessibleLabel}
      aria-describedby={ariaDescribedBy}
      className={cn(
        "inline-flex items-center rounded-lg border border-border/70 bg-card/80 text-xs text-foreground shadow-xs backdrop-blur-xs select-none dark:bg-zinc-900/85",
        disabled && "pointer-events-none opacity-60",
        className
      )}
    >
      {/* 1. Model Trigger & t3 code Popover */}
      <Popover open={modelPickerOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex min-w-0 items-center gap-2 rounded-l-lg px-2.5 py-1.5 transition-colors hover:bg-muted/70"
            title={`${selectedProviderLabel}: ${selectedModelLabel}`}
          >
            <ProviderIcon provider={provider} className="size-4 shrink-0" />
            <span className="max-w-[120px] truncate font-medium sm:max-w-[150px]">
              {selectedModelLabel}
            </span>
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[360px] overflow-hidden rounded-xl border border-border/80 bg-popover p-0 text-popover-foreground shadow-2xl"
        >
          <div className="flex h-[380px]">
            {/* Left Rail */}
            <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/50 bg-muted/20 py-2.5">
              {/* Favorites Tab */}
              <button
                type="button"
                onClick={() => setSelectedRailTab("favorites")}
                title="Favorites"
                aria-label="Favorites tab"
                className={cn(
                  "relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                  selectedRailTab === "favorites"
                    ? "bg-accent/50 text-amber-400"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                )}
              >
                <StarFilledIcon className="size-4" />
                {selectedRailTab === "favorites" ? (
                  <span className="absolute top-1/2 right-0 h-4.5 w-0.5 -translate-y-1/2 rounded-l-full bg-blue-500" />
                ) : null}
              </button>

              <div className="my-1 h-px w-6 bg-border/40" />

              {/* Provider Tabs */}
              {providerOptions.map((opt) => {
                const isSelected = selectedRailTab === opt.id
                const providerState = availability.find(
                  (item) => item.providerId === opt.id
                )
                const isAvailable =
                  availabilityError ||
                  (providerState?.available !== false &&
                    providerState?.authenticated !== false)
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSelectedRailTab(opt.id)
                    }}
                    title={opt.label}
                    aria-label={`${opt.label} models`}
                    disabled={!isAvailable}
                    className={cn(
                      "relative flex h-9 w-9 items-center justify-center rounded-md transition-colors",
                      !isAvailable && "cursor-not-allowed opacity-40",
                      isSelected
                        ? "bg-accent/50 text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    )}
                  >
                    <ProviderIcon provider={opt.id} className="size-4" />
                    {isSelected ? (
                      <span className="absolute top-1/2 right-0 h-4.5 w-0.5 -translate-y-1/2 rounded-l-full bg-blue-500" />
                    ) : null}
                  </button>
                )
              })}
            </div>

            {/* Right Main Content */}
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Search Bar */}
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
                <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Search models..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/70"
                  autoFocus
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery("")}
                    className="p-0.5 text-xs text-muted-foreground hover:text-foreground"
                    title="Clear search"
                  >
                    ✕
                  </button>
                ) : null}
              </div>

              {/* Models List */}
              <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
                {displayedModels.length === 0 ? (
                  <div className="px-4 py-12 text-center">
                    {selectedRailTab === "favorites" ? (
                      <>
                        <StarOutlineIcon className="mx-auto mb-2 size-7 text-muted-foreground/40" />
                        <p className="text-xs font-medium text-foreground">
                          No favorite models
                        </p>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Star any model to quickly access it from this tab.
                        </p>
                      </>
                    ) : (
                      <>
                        <SearchIcon className="mx-auto mb-2 size-7 text-muted-foreground/40" />
                        <p className="text-xs font-medium text-foreground">
                          No models match &ldquo;{searchQuery}&rdquo;
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <>
                    {/* Modern / Curated Models */}
                    {modernModels.map((item) => {
                      const isSelected =
                        item.id === model && item.provider === provider
                      return (
                        <div
                          key={`${item.provider}:${item.id}`}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            handleSelectModel(item.provider, item.id)
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              handleSelectModel(item.provider, item.id)
                            }
                          }}
                          className={cn(
                            "group flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors select-none",
                            isSelected
                              ? "bg-accent/80 font-medium text-accent-foreground"
                              : "text-foreground hover:bg-muted/70"
                          )}
                        >
                          <div className="min-w-0 flex-1 pr-2">
                            <p className="truncate font-medium">{item.label}</p>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                              <ProviderIcon
                                provider={item.provider}
                                className="size-3 shrink-0"
                              />
                              <span className="truncate">
                                {item.providerLabel}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleFavorite(item.id)
                            }}
                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                            title={
                              isFavorite(item.id)
                                ? "Remove from favorites"
                                : "Add to favorites"
                            }
                            aria-label={
                              isFavorite(item.id)
                                ? `Unfavorite ${item.label}`
                                : `Favorite ${item.label}`
                            }
                          >
                            {isFavorite(item.id) ? (
                              <StarFilledIcon className="size-3.5 fill-amber-400 text-amber-400" />
                            ) : (
                              <StarOutlineIcon className="size-3.5 opacity-60 group-hover:opacity-100" />
                            )}
                          </button>
                        </div>
                      )
                    })}

                    {/* Collapsible Legacy Models Section */}
                    {legacyModels.length > 0 ? (
                      <div className="pt-1">
                        {searchQuery ? (
                          legacyModels.map((item) => {
                            const isSelected =
                              item.id === model && item.provider === provider
                            return (
                              <div
                                key={`${item.provider}:${item.id}`}
                                role="button"
                                tabIndex={0}
                                onClick={() =>
                                  handleSelectModel(item.provider, item.id)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    handleSelectModel(item.provider, item.id)
                                  }
                                }}
                                className={cn(
                                  "group flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors select-none",
                                  isSelected
                                    ? "bg-accent/80 font-medium text-accent-foreground"
                                    : "text-foreground hover:bg-muted/70"
                                )}
                              >
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="truncate font-medium">
                                    {item.label}
                                  </p>
                                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                    <ProviderIcon
                                      provider={item.provider}
                                      className="size-3 shrink-0"
                                    />
                                    <span className="truncate">
                                      {item.providerLabel}
                                    </span>
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleFavorite(item.id)
                                  }}
                                  className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                  title={
                                    isFavorite(item.id)
                                      ? "Remove from favorites"
                                      : "Add to favorites"
                                  }
                                  aria-label={
                                    isFavorite(item.id)
                                      ? `Unfavorite ${item.label}`
                                      : `Favorite ${item.label}`
                                  }
                                >
                                  {isFavorite(item.id) ? (
                                    <StarFilledIcon className="size-3.5 fill-amber-400 text-amber-400" />
                                  ) : (
                                    <StarOutlineIcon className="size-3.5 opacity-60 group-hover:opacity-100" />
                                  )}
                                </button>
                              </div>
                            )
                          })
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setLegacyExpanded((v) => !v)}
                              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50"
                            >
                              <div>
                                <p className="font-medium text-foreground">
                                  Legacy models
                                </p>
                                <p className="text-[11px] text-muted-foreground">
                                  {legacyModels.length} models
                                </p>
                              </div>
                              <ChevronRightIcon
                                className={cn(
                                  "size-3.5 text-muted-foreground transition-transform",
                                  showLegacyModels && "rotate-90"
                                )}
                              />
                            </button>
                            {showLegacyModels ? (
                              <div className="mt-1 ml-2 space-y-0.5 border-l border-border/40 pl-1.5">
                                {legacyModels.map((item) => {
                                  const isSelected =
                                    item.id === model &&
                                    item.provider === provider
                                  return (
                                    <div
                                      key={`${item.provider}:${item.id}`}
                                      role="button"
                                      tabIndex={0}
                                      onClick={() =>
                                        handleSelectModel(
                                          item.provider,
                                          item.id
                                        )
                                      }
                                      onKeyDown={(e) => {
                                        if (
                                          e.key === "Enter" ||
                                          e.key === " "
                                        ) {
                                          handleSelectModel(
                                            item.provider,
                                            item.id
                                          )
                                        }
                                      }}
                                      className={cn(
                                        "group flex cursor-pointer items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors select-none",
                                        isSelected
                                          ? "bg-accent/80 font-medium text-accent-foreground"
                                          : "text-foreground hover:bg-muted/70"
                                      )}
                                    >
                                      <div className="min-w-0 flex-1 pr-2">
                                        <p className="truncate font-medium">
                                          {item.label}
                                        </p>
                                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                          <ProviderIcon
                                            provider={item.provider}
                                            className="size-3 shrink-0"
                                          />
                                          <span className="truncate">
                                            {item.providerLabel}
                                          </span>
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          toggleFavorite(item.id)
                                        }}
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                                        title={
                                          isFavorite(item.id)
                                            ? "Remove from favorites"
                                            : "Add to favorites"
                                        }
                                        aria-label={
                                          isFavorite(item.id)
                                            ? `Unfavorite ${item.label}`
                                            : `Favorite ${item.label}`
                                        }
                                      >
                                        {isFavorite(item.id) ? (
                                          <StarFilledIcon className="size-3.5 fill-amber-400 text-amber-400" />
                                        ) : (
                                          <StarOutlineIcon className="size-3.5 opacity-60 group-hover:opacity-100" />
                                        )}
                                      </button>
                                    </div>
                                  )
                                })}
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Segment Divider */}
      <div className="h-4 w-px shrink-0 bg-border/60" />

      {/* 2. Reasoning Effort Trigger & Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || supportedReasoningEfforts.length <= 1}
            className="flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            title={`Reasoning: ${selectedReasoningLabel}`}
          >
            <span className="truncate font-normal">
              {selectedReasoningLabel}
            </span>
            {supportedReasoningEfforts.length > 1 ? (
              <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-40">
          <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
          {supportedReasoningEfforts.map((effort) => (
            <DropdownMenuItem
              key={effort}
              onSelect={() => onChange(model, effort, provider)}
              className="justify-between text-xs"
            >
              <span>{reasoningLabel(effort)}</span>
              {effort === reasoning ? (
                <CheckIcon aria-hidden="true" className="size-3.5 text-brand" />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* 3. Access Level Trigger & Dropdown (When shown) */}
      {showAccessPolicy && accessPolicy && onAccessPolicyChange ? (
        <>
          <div className="h-4 w-px shrink-0 bg-border/60" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || supportedAccessPolicies.length <= 1}
                className="flex shrink-0 items-center gap-1.5 rounded-r-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                title={`Access level: ${accessPolicyLabel(accessPolicy, provider)}`}
              >
                <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-normal">
                  {accessPolicyLabel(accessPolicy, provider)}
                </span>
                {supportedAccessPolicies.length > 1 ? (
                  <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Access level</DropdownMenuLabel>
              {supportedAccessPolicies.map((policy) => (
                <DropdownMenuItem
                  key={policy}
                  onSelect={() => onAccessPolicyChange(policy)}
                  className="justify-between py-1.5 text-xs"
                >
                  <div className="min-w-0 pr-2">
                  <p className="font-medium">
                    {accessPolicyLabel(policy, provider)}
                  </p>
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                      {accessPolicyDescription(policy, provider)}
                    </p>
                  </div>
                  {policy === accessPolicy ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-brand"
                    />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null}
    </div>
  )
}
