"use client"

/** Renders the shared model and reasoning picker used in chat and settings. */

import { Fragment } from "react"

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
  getCodexModelPickerOptions,
  getSupportedAiReasoningEfforts,
  groupCodexModelOptions,
  type AiReasoningEffort,
} from "@/lib/ai-model-settings"
import { cn } from "@/lib/utils"

/** Props for one controlled model and reasoning selection. */
export type ModelReasoningPickerProps = {
  /** The model ID currently selected by the owning form. */
  model: string
  /** The reasoning level currently selected by the owning form. */
  reasoning: AiReasoningEffort
  /** Prevents opening or changing the picker while the owner is busy. */
  disabled?: boolean
  /** Receives a complete model and reasoning pair after a submenu choice. */
  onChange: (model: string, reasoning: AiReasoningEffort) => void
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
  return effort === "xhigh"
    ? "Extra high"
    : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

/** Renders one controlled picker and reports model-reasoning choices to its owner. */
export function ModelReasoningPicker({
  model,
  reasoning,
  disabled = false,
  onChange,
  labelPrefix = "Model",
  className,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: ModelReasoningPickerProps) {
  const modelOptions = getCodexModelPickerOptions(model)
  const selectedModel = modelOptions.find((option) => option.id === model)
  const selectedModelLabel = selectedModel?.label ?? model
  const groups = groupCodexModelOptions(modelOptions)
  const selectedReasoningLabel = reasoningLabel(reasoning)
  const accessibleLabel = `${labelPrefix} ${selectedModelLabel}, ${selectedReasoningLabel} reasoning`

  return (
    <div className="flex min-w-0 items-center">
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
              "h-8 max-w-[15rem] min-w-0 gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground",
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
              {group.options.map((option) => (
                <DropdownMenuSub key={option.id}>
                  <DropdownMenuSubTrigger
                    disabled={disabled}
                    className="min-w-0 text-xs"
                  >
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-36">
                    <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
                    {getSupportedAiReasoningEfforts(option.id).map((effort) => {
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
              ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
