"use client"

/** Lets learners choose the saved model and reasoning level for replies without leaving chat. */

import { Fragment, useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"

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
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  type CodexModelOption,
  getCodexModelPickerOptions,
  getSupportedAiReasoningEfforts,
  validateAiModelSettings,
  type AiModelSettings,
  type AiReasoningEffort,
} from "@/lib/ai-model-settings"

/** Options that let a parent prevent a configuration race with an active chat turn. */
type ReplyModelPickerProps = {
  disabled?: boolean
  onSaveStateChange?: (saving: boolean) => void
}

/** Formats a machine-readable effort value for a compact picker label. */
function reasoningLabel(effort: AiReasoningEffort): string {
  return effort === "xhigh"
    ? "Extra high"
    : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

/** Groups model choices by their visible GPT generation for a readable menu. */
function groupModelOptions(
  options: readonly CodexModelOption[]
): Array<{ generation: string; options: CodexModelOption[] }> {
  const grouped = new Map<string, CodexModelOption[]>()
  for (const option of options) {
    const generation = option.label.match(/^GPT-[\d.]+/i)?.[0] ?? "Other"
    const group = grouped.get(generation)
    if (group) group.push(option)
    else grouped.set(generation, [option])
  }
  return Array.from(grouped, ([generation, groupedOptions]) => ({
    generation,
    options: groupedOptions,
  }))
}

/** Loads the saved reply configuration before rendering its compact controls. */
export function ReplyModelPicker({
  disabled = false,
  onSaveStateChange,
}: ReplyModelPickerProps) {
  const savedSettings = useQuery(api.settings.get)
  if (savedSettings === undefined)
    return (
      <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
        Loading reply model…
      </p>
    )

  return (
    <ReplyModelPickerEditor
      key={JSON.stringify(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS)}
      initialSettings={{ ...(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS) }}
      disabled={disabled}
      onSaveStateChange={onSaveStateChange}
    />
  )
}

/** Saves an optimistic reply-only selection while preserving settings for the other AI tasks. */
function ReplyModelPickerEditor({
  initialSettings,
  disabled,
  onSaveStateChange,
}: {
  initialSettings: AiModelSettings
  disabled: boolean
  onSaveStateChange?: (saving: boolean) => void
}) {
  const saveSettings = useMutation(api.settings.save)
  const [draft, setDraft] = useState<AiModelSettings>(initialSettings)
  const [isSaving, setIsSaving] = useState(false)
  const [feedback, setFeedback] = useState("")

  useEffect(() => () => onSaveStateChange?.(false), [onSaveStateChange])

  /** Updates local and parent saving state together so a reply cannot start on stale settings. */
  const setSaving = (saving: boolean): void => {
    setIsSaving(saving)
    onSaveStateChange?.(saving)
  }

  /** Validates and saves an updated reply selection while retaining all other task settings. */
  const persist = async (next: AiModelSettings): Promise<void> => {
    if (disabled || isSaving) return
    setDraft(next)
    setFeedback("")
    setSaving(true)
    try {
      const saved = await saveSettings(validateAiModelSettings(next))
      setDraft(saved)
    } catch {
      setDraft(initialSettings)
      setFeedback("Could not save the reply model. Try again.")
    } finally {
      setSaving(false)
    }
  }

  /** Saves a model and its reasoning choice as one reply configuration. */
  const selectModelAndReasoning = (
    model: string,
    effort: AiReasoningEffort
  ): void => {
    void persist({ ...draft, replyModel: model, replyEffort: effort })
  }

  const isDisabled = disabled || isSaving
  const modelOptions = getCodexModelPickerOptions(draft.replyModel)
  const selectedModel = modelOptions.find(
    (option) => option.id === draft.replyModel
  )
  const selectedModelLabel = selectedModel?.label ?? draft.replyModel
  const groups = groupModelOptions(modelOptions)

  return (
    <div className="flex min-w-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            disabled={isDisabled}
            aria-label={`Reply model ${selectedModelLabel}, ${reasoningLabel(draft.replyEffort)} reasoning`}
            title={`${selectedModelLabel}, ${reasoningLabel(draft.replyEffort)} reasoning`}
            className="h-8 max-w-[15rem] min-w-0 gap-1 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="truncate">{selectedModelLabel}</span>
            <span className="shrink-0 text-muted-foreground/70">
              · {reasoningLabel(draft.replyEffort)}
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          {groups.map((group, groupIndex) => (
            <Fragment key={group.generation}>
              {groupIndex ? <DropdownMenuSeparator /> : null}
              {group.options.map((option) => (
                <DropdownMenuSub key={option.id}>
                  <DropdownMenuSubTrigger
                    disabled={isDisabled}
                    className="min-w-0"
                  >
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-40">
                    <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
                    {getSupportedAiReasoningEfforts(option.id).map((effort) => {
                      const isSelected =
                        option.id === draft.replyModel &&
                        effort === draft.replyEffort
                      return (
                        <DropdownMenuItem
                          key={effort}
                          onSelect={() =>
                            selectModelAndReasoning(option.id, effort)
                          }
                          className="justify-between"
                        >
                          <span>{reasoningLabel(effort)}</span>
                          {isSelected ? (
                            <CheckIcon
                              aria-hidden="true"
                              className="size-4 text-brand"
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
      <span aria-live="polite" className="sr-only">
        {isSaving ? "Saving reply model" : feedback}
      </span>
    </div>
  )
}
