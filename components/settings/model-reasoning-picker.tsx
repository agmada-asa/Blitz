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

import { useEffect, useMemo, useState } from "react"

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
  type AiApprovalPolicy,
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
  /** Receives a complete model and reasoning pair after a model choice. */
  onChange: (model: string, reasoning: AiReasoningEffort) => void
  /** Receives an explicit provider change before the parent updates its model. */
  onProviderChange?: (provider: AiProviderId) => void
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

/** Returns a concise, user-friendly label for one access/approval policy. */
export function accessPolicyLabel(policy: AiApprovalPolicy): string {
  switch (policy) {
    case "full-access":
      return "Full access"
    case "on-request":
      return "Ask when needed"
    case "untrusted":
      return "Ask for untrusted"
    case "never":
      return "Never approve"
    default:
      return policy
  }
}

/** Returns a short explanation of what an access policy grants. */
export function accessPolicyDescription(
  policy: AiApprovalPolicy,
  provider?: AiProviderId
): string {
  switch (policy) {
    case "full-access":
      return "Tools run automatically without interactive prompts"
    case "on-request":
      return "Prompts for approval when actions require review"
    case "untrusted":
      return "Prompts only on untrusted or risky operations"
    case "never":
      return provider === "antigravity"
        ? "Denies permission requests in workspace chat"
        : "Denies all tool approval requests"
    default:
      return ""
  }
}

/** Returns whether a model is considered a legacy model generation. */
function isLegacyModel(modelId: string): boolean {
  return (
    modelId.startsWith("gpt-5.5") ||
    modelId.startsWith("gpt-5.4") ||
    modelId.startsWith("gpt-5.3") ||
    modelId.startsWith("gpt-4")
  )
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
  onProviderChange,
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
  const [legacyExpanded, setLegacyExpanded] = useState(isLegacyModel(model))
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
      setLegacyExpanded(isLegacyModel(model))
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

  const modelOptions = useMemo(
    () => getAiModelPickerOptions(provider, model),
    [provider, model]
  )

  const selectedModel = modelOptions.find((option) => option.id === model)
  const selectedModelLabel = selectedModel?.label ?? model
  const selectedProviderLabel =
    AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ??
    provider

  const supportedReasoningEfforts = useMemo(
    () => getSupportedAiReasoningEffortsForProvider(provider, model),
    [provider, model]
  )

  const selectedReasoningLabel = reasoningLabel(reasoning)

  const supportedAccessPolicies = useMemo(() => {
    return AI_PROVIDER_APPROVAL_POLICIES[provider] ?? ["never"]
  }, [provider])

  /** Handles selecting a model from the list, switching provider and updating reasoning if necessary. */
  const handleSelectModel = (
    chosenProvider: AiProviderId,
    chosenModelId: string
  ): void => {
    if (disabled) return
    if (chosenProvider !== provider && onProviderChange) {
      onProviderChange(chosenProvider)
    }

    const nextEfforts = getSupportedAiReasoningEffortsForProvider(
      chosenProvider,
      chosenModelId
    )
    const nextReasoning = nextEfforts.includes(reasoning)
      ? reasoning
      : (nextEfforts[0] ?? "medium")

    onChange(chosenModelId, nextReasoning)
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
        const opts = getAiModelPickerOptions(p.id, model)
        for (const opt of opts) {
          if (favorites.includes(opt.id)) {
            all.push({
              id: opt.id,
              label: opt.label,
              provider: p.id,
              providerLabel: p.label,
              isLegacy: isLegacyModel(opt.id),
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
    const opts = getAiModelPickerOptions(pId, pId === provider ? model : "")
    const enriched = opts.map((opt) => ({
      id: opt.id,
      label: opt.label,
      provider: pId,
      providerLabel: pOpt?.label ?? pId,
      isLegacy: isLegacyModel(opt.id),
    }))

    if (!query) return enriched
    return enriched.filter(
      (m) =>
        m.label.toLowerCase().includes(query) ||
        m.id.toLowerCase().includes(query)
    )
  }, [selectedRailTab, providerOptions, provider, model, favorites, searchQuery])

  const modernModels = useMemo(
    () => displayedModels.filter((m) => !m.isLegacy),
    [displayedModels]
  )

  const legacyModels = useMemo(
    () => displayedModels.filter((m) => m.isLegacy),
    [displayedModels]
  )

  const accessibleLabel = `${labelPrefix} ${selectedProviderLabel}, ${selectedModelLabel}, ${selectedReasoningLabel} reasoning${
    accessPolicy ? `, ${accessPolicyLabel(accessPolicy)} access` : ""
  }`

  return (
    <div
      aria-label={ariaLabel ?? accessibleLabel}
      aria-describedby={ariaDescribedBy}
      className={cn(
        "inline-flex items-center rounded-lg border border-border/70 bg-card/80 dark:bg-zinc-900/85 text-xs text-foreground shadow-xs select-none backdrop-blur-xs",
        disabled && "opacity-60 pointer-events-none",
        className
      )}
    >
      {/* 1. Model Trigger & t3 code Popover */}
      <Popover open={modelPickerOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/70 transition-colors rounded-l-lg min-w-0"
            title={`${selectedProviderLabel}: ${selectedModelLabel}`}
          >
            <ProviderIcon provider={provider} className="size-4 shrink-0" />
            <span className="font-medium truncate max-w-[120px] sm:max-w-[150px]">
              {selectedModelLabel}
            </span>
            <ChevronDownIcon className="size-3 text-muted-foreground shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-[360px] p-0 overflow-hidden border border-border/80 bg-popover text-popover-foreground shadow-2xl rounded-xl"
        >
          <div className="flex h-[380px]">
            {/* Left Rail */}
            <div className="w-12 shrink-0 border-r border-border/50 bg-muted/20 py-2.5 flex flex-col items-center gap-1">
              {/* Favorites Tab */}
              <button
                type="button"
                onClick={() => setSelectedRailTab("favorites")}
                title="Favorites"
                aria-label="Favorites tab"
                className={cn(
                  "relative w-9 h-9 rounded-md flex items-center justify-center transition-colors",
                  selectedRailTab === "favorites"
                    ? "text-amber-400 bg-accent/50"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                )}
              >
                <StarFilledIcon className="size-4" />
                {selectedRailTab === "favorites" ? (
                  <span className="absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-4.5 bg-blue-500 rounded-l-full" />
                ) : null}
              </button>

              <div className="w-6 h-px bg-border/40 my-1" />

              {/* Provider Tabs */}
              {providerOptions.map((opt) => {
                const isSelected = selectedRailTab === opt.id
                const isAvailable =
                  availabilityError ||
                  availability.find((item) => item.providerId === opt.id)
                    ?.available !== false
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSelectedRailTab(opt.id)
                      if (onProviderChange && opt.id !== provider) {
                        onProviderChange(opt.id)
                      }
                    }}
                    title={opt.label}
                    aria-label={`${opt.label} models`}
                    disabled={!isAvailable}
                    className={cn(
                      "relative w-9 h-9 rounded-md flex items-center justify-center transition-colors",
                      !isAvailable && "opacity-40 cursor-not-allowed",
                      isSelected
                        ? "text-foreground bg-accent/50"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
                    )}
                  >
                    <ProviderIcon provider={opt.id} className="size-4" />
                    {isSelected ? (
                      <span className="absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-4.5 bg-blue-500 rounded-l-full" />
                    ) : null}
                  </button>
                )
              })}
            </div>

            {/* Right Main Content */}
            <div className="flex-1 flex flex-col min-w-0">
              {/* Search Bar */}
              <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
                <SearchIcon className="size-3.5 text-muted-foreground shrink-0" />
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
                    className="text-muted-foreground hover:text-foreground text-xs p-0.5"
                    title="Clear search"
                  >
                    ✕
                  </button>
                ) : null}
              </div>

              {/* Models List */}
              <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
                {displayedModels.length === 0 ? (
                  <div className="py-12 px-4 text-center">
                    {selectedRailTab === "favorites" ? (
                      <>
                        <StarOutlineIcon className="size-7 text-muted-foreground/40 mx-auto mb-2" />
                        <p className="text-xs font-medium text-foreground">
                          No favorite models
                        </p>
                        <p className="text-[11px] text-muted-foreground mt-1">
                          Star any model to quickly access it from this tab.
                        </p>
                      </>
                    ) : (
                      <>
                        <SearchIcon className="size-7 text-muted-foreground/40 mx-auto mb-2" />
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
                            "group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs select-none",
                            isSelected
                              ? "bg-accent/80 text-accent-foreground font-medium"
                              : "hover:bg-muted/70 text-foreground"
                          )}
                        >
                          <div className="min-w-0 flex-1 pr-2">
                            <p className="truncate font-medium">{item.label}</p>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground">
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
                            className="p-1 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground transition-colors shrink-0"
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
                              <StarFilledIcon className="size-3.5 text-amber-400 fill-amber-400" />
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
                                  "group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs select-none",
                                  isSelected
                                    ? "bg-accent/80 text-accent-foreground font-medium"
                                    : "hover:bg-muted/70 text-foreground"
                                )}
                              >
                                <div className="min-w-0 flex-1 pr-2">
                                  <p className="truncate font-medium">
                                    {item.label}
                                  </p>
                                  <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground">
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
                                  className="p-1 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground transition-colors shrink-0"
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
                                    <StarFilledIcon className="size-3.5 text-amber-400 fill-amber-400" />
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
                              className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg hover:bg-muted/50 transition-colors text-xs text-left"
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
                                  legacyExpanded && "rotate-90"
                                )}
                              />
                            </button>
                            {legacyExpanded ? (
                              <div className="space-y-0.5 pl-1.5 border-l border-border/40 ml-2 mt-1">
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
                                        "group flex items-center justify-between px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors text-xs select-none",
                                        isSelected
                                          ? "bg-accent/80 text-accent-foreground font-medium"
                                          : "hover:bg-muted/70 text-foreground"
                                      )}
                                    >
                                      <div className="min-w-0 flex-1 pr-2">
                                        <p className="truncate font-medium">
                                          {item.label}
                                        </p>
                                        <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground">
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
                                        className="p-1 rounded hover:bg-background/80 text-muted-foreground hover:text-foreground transition-colors shrink-0"
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
                                          <StarFilledIcon className="size-3.5 text-amber-400 fill-amber-400" />
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
      <div className="h-4 w-px bg-border/60 shrink-0" />

      {/* 2. Reasoning Effort Trigger & Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || supportedReasoningEfforts.length <= 1}
            className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/70 transition-colors text-muted-foreground hover:text-foreground shrink-0"
            title={`Reasoning: ${selectedReasoningLabel}`}
          >
            <span className="truncate font-normal">
              {selectedReasoningLabel}
            </span>
            {supportedReasoningEfforts.length > 1 ? (
              <ChevronDownIcon className="size-3 text-muted-foreground shrink-0" />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-40">
          <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
          {supportedReasoningEfforts.map((effort) => (
            <DropdownMenuItem
              key={effort}
              onSelect={() => onChange(model, effort)}
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
          <div className="h-4 w-px bg-border/60 shrink-0" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled || supportedAccessPolicies.length <= 1}
                className="flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/70 transition-colors text-muted-foreground hover:text-foreground rounded-r-lg shrink-0"
                title={`Access level: ${accessPolicyLabel(accessPolicy)}`}
              >
                <LockIcon className="size-3.5 text-muted-foreground shrink-0" />
                <span className="truncate font-normal">
                  {accessPolicyLabel(accessPolicy)}
                </span>
                {supportedAccessPolicies.length > 1 ? (
                  <ChevronDownIcon className="size-3 text-muted-foreground shrink-0" />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Access level</DropdownMenuLabel>
              {supportedAccessPolicies.map((policy) => (
                <DropdownMenuItem
                  key={policy}
                  onSelect={() => onAccessPolicyChange(policy)}
                  className="justify-between text-xs py-1.5"
                >
                  <div className="min-w-0 pr-2">
                    <p className="font-medium">{accessPolicyLabel(policy)}</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                      {accessPolicyDescription(policy, provider)}
                    </p>
                  </div>
                  {policy === accessPolicy ? (
                    <CheckIcon
                      aria-hidden="true"
                      className="size-3.5 text-brand shrink-0"
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
