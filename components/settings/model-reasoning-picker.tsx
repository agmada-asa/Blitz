"use client"

/** Renders the shared model and reasoning picker used in chat and settings. */

import { Fragment, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CheckIcon } from "@/components/ui/icon"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AI_PROVIDER_OPTIONS,
  getAiProviderOptionsForTask,
  getAiModelPickerOptions,
  getSupportedAiReasoningEffortsForProvider,
  groupCodexModelOptions,
  type AiProviderId,
  type AiReasoningEffort,
  type AiTask,
} from "@/lib/ai-model-settings"
import type { ProviderAvailability } from "@/lib/server/providers/types"
import { cn } from "@/lib/utils"

/** Props for one controlled model and reasoning selection. */
export type ModelReasoningPickerProps = {
  /** Provider integration currently selected for the task. */
  provider?: AiProviderId
  /** Task capability used to omit providers that cannot safely run this work. */
  task?: AiTask
  /** The model ID currently selected by the owning form. */
  model: string
  /** The reasoning level currently selected by the owning form. */
  reasoning: AiReasoningEffort
  /** Prevents opening or changing the picker while the owner is busy. */
  disabled?: boolean
  /** Receives a complete model and reasoning pair after a submenu choice. */
  onChange: (model: string, reasoning: AiReasoningEffort) => void
  /** Receives an explicit provider change before the parent updates its model. */
  onProviderChange?: (provider: AiProviderId) => void
  /** Names the task in the generated accessible label. */
  labelPrefix?: string
  /** Additional classes for the visible trigger. */
  className?: string
  /** Accessible name for the combined control. */
  "aria-label"?: string
  /** Optional description reference for the combined control. */
  "aria-describedby"?: string
}

/** Formats a machine-readable effort value for the visible picker label. */
function reasoningLabel(effort: AiReasoningEffort): string {
  if (effort === "default") return "Provider default"
  return effort === "xhigh"
    ? "Extra high"
    : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

/** Renders one controlled picker and reports model-reasoning choices to its owner. */
export function ModelReasoningPicker({
  provider = "codex",
  task,
  model,
  reasoning,
  disabled = false,
  onChange,
  onProviderChange,
  labelPrefix = "Model",
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: ModelReasoningPickerProps) {
  const [availability, setAvailability] = useState<ProviderAvailability[]>([])
  const [availabilityError, setAvailabilityError] = useState(false)
  const [probe, setProbe] = useState(0)
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
  const hasReasoning = provider !== "opencode" && provider !== "antigravity"
  const modelOptions = getAiModelPickerOptions(provider, model)
  const selectedModel = modelOptions.find((option) => option.id === model)
  const selectedModelLabel = selectedModel?.label ?? model
  const groups = groupCodexModelOptions(modelOptions)
  const selectedReasoningLabel = hasReasoning
    ? reasoningLabel(reasoning)
    : "Provider default"
  const selectedProviderLabel =
    AI_PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ??
    provider
  const providerOptions = task
    ? getAiProviderOptionsForTask(task)
    : AI_PROVIDER_OPTIONS
  const accessibleLabel = `${labelPrefix} ${selectedProviderLabel}, ${selectedModelLabel}, ${selectedReasoningLabel} reasoning`

  return (
    <div className="flex min-w-0 items-center gap-1">
      {onProviderChange ? (
        <Select
          value={provider}
          onOpenChange={(open) => {
            if (open) setProbe((value) => value + 1)
          }}
          onValueChange={(value) => {
            if (value !== provider) onProviderChange(value as AiProviderId)
          }}
          disabled={disabled}
        >
          <SelectTrigger
            variant="ghost"
            className="h-8 max-w-32 min-w-24 text-xs"
            aria-label={`${labelPrefix} provider`}
          >
            <SelectValue>{selectedProviderLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent
            align="start"
            className="w-72 max-w-[calc(100vw-2rem)]"
          >
            {providerOptions.map((option) => (
              <SelectItem
                key={option.id}
                value={option.id}
                className="text-xs"
                disabled={
                  availabilityError ||
                  !availability.find((item) => item.providerId === option.id)
                    ?.available
                }
              >
                <span className="font-medium">{option.label}</span>
                <span className="mt-1 block whitespace-normal text-muted-foreground">
                  {availabilityError
                    ? "Could not check setup. Reopen to retry."
                    : (availability.find(
                        (item) => item.providerId === option.id
                      )?.message ?? "Checking setup…")}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            aria-label={ariaLabel ?? accessibleLabel}
            aria-describedby={ariaDescribedBy}
            title={`${selectedModelLabel}, ${selectedReasoningLabel} reasoning`}
            className={cn(
              "h-8 max-w-[15rem] min-w-0 shrink gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground",
              className
            )}
          >
            <span className="truncate">{selectedModelLabel}</span>
            <span className="shrink-0 text-muted-foreground/70">
              · {selectedReasoningLabel}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          {groups.map((group, groupIndex) => (
            <Fragment key={group.generation}>
              {groupIndex ? <DropdownMenuSeparator /> : null}
              {group.options.map((option) =>
                getSupportedAiReasoningEffortsForProvider(
                  provider,
                  option.id
                )[0] === "default" ? (
                  <DropdownMenuItem
                    key={option.id}
                    disabled={disabled}
                    onSelect={() => onChange(option.id, "default")}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuSub key={option.id}>
                    <DropdownMenuSubTrigger
                      disabled={disabled}
                      className="min-w-0 text-xs"
                    >
                      <span className="truncate">{option.label}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-36">
                      <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
                      {getSupportedAiReasoningEffortsForProvider(
                        provider,
                        option.id
                      ).map((effort) => {
                        const isSelected =
                          option.id === model && effort === reasoning
                        return (
                          <DropdownMenuItem
                            key={effort}
                            onSelect={() => {
                              if (option.id !== model || effort !== reasoning)
                                onChange(option.id, effort)
                            }}
                            className="justify-between text-xs"
                          >
                            <span>{reasoningLabel(effort)}</span>
                            {isSelected ? (
                              <CheckIcon
                                aria-hidden="true"
                                className="size-3.5 text-brand"
                              />
                            ) : null}
                          </DropdownMenuItem>
                        )
                      })}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
