"use client"

/**
 * Lets learners choose the saved model, reasoning level, and access policy for replies without leaving chat.
 *
 * This component integrates the t3 code model and reasoning picker directly into the chat composer,
 * providing one-click access to model selection, reasoning effort levels, and tool access policies.
 */

import { useEffect, useState } from "react"
import { useMutation, useQuery } from "convex/react"

import { ModelReasoningPicker } from "@/components/settings/model-reasoning-picker"
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  resolveAiProvider,
  resolveProviderApprovalPolicy,
  validateAiModelSettings,
  type AiApprovalPolicy,
  type AiModelSettings,
  type AiProviderId,
  type AiReasoningEffort,
} from "@/lib/ai-model-settings"

/** Options that let a parent lock the picker and track in-flight saves. */
type ReplyModelPickerProps = {
  /** Prevents changing settings; replies already running keep the settings they started with. */
  disabled?: boolean
  /** Notifies the parent composer when an asynchronous save operation is running. */
  onSaveStateChange?: (saving: boolean) => void
}

/**
 * Loads the saved reply configuration before rendering its compact controls.
 *
 * @param props - Disabled state and save state callbacks.
 * @returns The reply model picker editor or a loading indicator.
 */
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

/** Saves an optimistic reply selection while preserving settings for other AI tasks. */
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

  /** Saves a provider, model, and reasoning choice as one reply configuration. */
  const selectModelAndReasoning = (
    model: string,
    effort: AiReasoningEffort,
    provider: AiProviderId
  ): void => {
    void persist({
      ...draft,
      replyProvider: provider,
      replyModel: model,
      replyEffort: effort,
    })
  }

  /** Updates the approval policy for the current reply provider. */
  const selectAccessPolicy = (policy: AiApprovalPolicy): void => {
    const provider = resolveAiProvider(draft, "replyProvider")
    void persist({
      ...draft,
      providerApprovalPolicies: {
        ...draft.providerApprovalPolicies,
        [provider]: policy,
      },
    })
  }

  const currentProvider = resolveAiProvider(draft, "replyProvider")
  const currentAccessPolicy = resolveProviderApprovalPolicy(
    draft,
    currentProvider
  )
  const isDisabled = disabled || isSaving

  return (
    <div className="flex min-w-0 items-center">
      <ModelReasoningPicker
        task="reply"
        provider={currentProvider}
        model={draft.replyModel}
        reasoning={draft.replyEffort}
        accessPolicy={currentAccessPolicy}
        onAccessPolicyChange={selectAccessPolicy}
        showAccessPolicy={true}
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
