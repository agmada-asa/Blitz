"use client"

/** Lets learners choose the saved model and reasoning level for replies without leaving chat. */

import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"

import { ModelReasoningPicker } from "@/components/settings/model-reasoning-picker"
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  validateAiModelSettings,
  type AiModelSettings,
  type AiReasoningEffort,
} from "@/lib/ai-model-settings"

/** Options that let a parent prevent a configuration race with an active chat turn. */
type ReplyModelPickerProps = {
  disabled?: boolean
  onSaveStateChange?: (saving: boolean) => void
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

  return (
    <div className="flex min-w-0 items-center">
      <ModelReasoningPicker
        model={draft.replyModel}
        reasoning={draft.replyEffort}
        disabled={isDisabled}
        labelPrefix="Reply model"
        onChange={selectModelAndReasoning}
      />
      <span aria-live="polite" className="sr-only">
        {isSaving ? "Saving reply model" : feedback}
      </span>
    </div>
  )
}
