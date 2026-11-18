"use client"

/** Owns the editable, persisted model and reasoning choices for each AI task in Blitz. */

import { providerAccessChoice } from "@/lib/provider-capabilities"
import { useState } from "react"
import { useMutation, useQuery } from "convex/react"

import { ModelReasoningPicker } from "@/components/settings/model-reasoning-picker"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import type { ProviderAvailability } from "@/lib/server/providers/types"
import { api } from "@/convex/_generated/api"
import {
  AI_PROVIDER_OPTIONS,
  AI_PROVIDER_APPROVAL_POLICIES,
  resolveProviderApprovalPolicy,
  type AiApprovalPolicy,
  DEFAULT_AI_MODEL_SETTINGS,
  resolveAiProvider,
  validateAiModelSettings,
  validateAiTaskProviders,
  type AiProviderModelCatalogs,
  type AiModelField,
  type AiModelSettings,
  type AiProviderField,
  type AiProviderId,
  type AiReasoningEffort,
  type AiReasoningField,
  type AiTask,
} from "@/lib/ai-model-settings"

/** One user-facing AI setting and the task it controls. */
const MODEL_FIELDS: Array<{
  task: AiTask
  providerField: AiProviderField
  modelField: AiModelField
  effortField: AiReasoningField
  label: string
  description: string
}> = [
  {
    task: "research",
    providerField: "researchProvider",
    modelField: "researchModel",
    effortField: "researchEffort",
    label: "Research",
    description: "Plans research and looks for sources to learn from.",
  },
  {
    task: "cardGeneration",
    providerField: "cardGenerationProvider",
    modelField: "cardGenerationModel",
    effortField: "cardGenerationEffort",
    label: "Practice questions",
    description: "Writes practice questions and recaps from your units.",
  },
  {
    task: "reply",
    providerField: "replyProvider",
    modelField: "replyModel",
    effortField: "replyEffort",
    label: "Teaching and chat",
    description: "Teaches your units and answers questions in chat.",
  },
]

/** Copy and intent for the save result announced to assistive technology. */
type SaveFeedback = { tone: "error" | "success"; message: string } | null

/**
 * Renders the saved model fields. Every change saves straight away as one
 * complete configuration, so there is no separate save step.
 */
export function ModelSettingsForm() {
  const savedSettings = useQuery(api.settings.get)
  // Held here because the editor remounts whenever a save changes the stored
  // settings, and the "saved" confirmation must survive that remount.
  const [feedback, setFeedback] = useState<SaveFeedback>(null)
  if (savedSettings === undefined) return <ModelSettingsLoading />

  return (
    <ModelSettingsEditor
      key={JSON.stringify(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS)}
      initialSettings={{ ...(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS) }}
      feedback={feedback}
      onFeedback={setFeedback}
    />
  )
}

/**
 * Edits one stable settings snapshot and saves each change as it is made.
 * Controls are disabled while a save runs, so changes never overlap. A failed
 * save keeps the learner's choice on screen with the reason and a retry.
 */
function ModelSettingsEditor({
  initialSettings,
  feedback,
  onFeedback,
}: {
  initialSettings: AiModelSettings
  /** The latest save result, owned by the parent so it outlives a remount. */
  feedback: SaveFeedback
  onFeedback: (feedback: SaveFeedback) => void
}) {
  const saveSettings = useMutation(api.settings.save)
  const [draft, setDraft] = useState<AiModelSettings>(initialSettings)
  const [isSaving, setIsSaving] = useState(false)

  /** Shows a change at once and saves it. */
  const change = (next: AiModelSettings): void => {
    setDraft(next)
    void save(next)
  }

  /** Updates one task's provider, model, and reasoning choice and saves it. */
  const updateSelection = (
    providerField: AiProviderField,
    modelField: AiModelField,
    effortField: AiReasoningField,
    model: string,
    reasoning: AiReasoningEffort,
    provider: AiProviderId
  ): void => {
    change({
      ...draft,
      [providerField]: provider,
      [modelField]: model,
      [effortField]: reasoning,
    })
  }

  /** Validates the complete configuration, then persists it in one Convex mutation. */
  const save = async (next: AiModelSettings): Promise<void> => {
    if (isSaving) return
    let settings: AiModelSettings
    try {
      settings = validateAiModelSettings(next)
      validateAiTaskProviders(settings)
    } catch (error) {
      onFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Choose a valid model and reasoning level for every task.",
      })
      return
    }
    setIsSaving(true)
    onFeedback(null)
    try {
      const response = await fetch("/api/providers", { cache: "no-store" })
      if (!response.ok)
        throw new Error("Could not check provider setup. Try again.")
      const availability = (await response.json()) as ProviderAvailability[]
      for (const { providerField } of MODEL_FIELDS) {
        const provider = availability.find(
          (item) =>
            item.providerId === resolveAiProvider(settings, providerField)
        )
        if (!provider?.available || provider.authenticated === false)
          throw new Error(
            provider?.message ?? "Could not check provider setup. Try again."
          )
      }
      const modelCatalogs: AiProviderModelCatalogs = {}
      for (const provider of availability) {
        if (provider.models?.length)
          modelCatalogs[provider.providerId] = provider.models
      }
      settings = validateAiModelSettings(settings, modelCatalogs)
      const saved = await saveSettings(settings)
      setDraft(saved)
      onFeedback({ tone: "success", message: "AI settings saved." })
    } catch (error) {
      onFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save AI settings. Try again.",
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Model and reasoning choices</CardTitle>
          <CardDescription>
            Pick a model and the amount of reasoning it should use for each
            task.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {MODEL_FIELDS.map(
            ({
              task,
              providerField,
              modelField,
              effortField,
              label,
              description,
            }) => {
              const inputId = `ai-model-${modelField}`
              const descriptionId = `${inputId}-description`
              const selectedModel = draft[modelField]
              const selectedEffort = draft[effortField]
              const selectedProvider = resolveAiProvider(draft, providerField)
              return (
                <div
                  key={modelField}
                  className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] sm:items-center sm:gap-6"
                >
                  <div>
                    <h3 className="text-sm font-medium">{label}</h3>
                    <p
                      id={descriptionId}
                      className="mt-1 text-sm leading-5 text-muted-foreground"
                    >
                      {description}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium">
                      {task === "reply"
                        ? "Model, reasoning, and access"
                        : "Model and reasoning"}
                    </p>
                    <div>
                      <ModelReasoningPicker
                        task={task}
                        provider={selectedProvider}
                        model={selectedModel}
                        reasoning={selectedEffort}
                        accessPolicy={
                          task === "reply"
                            ? resolveProviderApprovalPolicy(
                                draft,
                                selectedProvider
                              )
                            : undefined
                        }
                        showAccessPolicy={task === "reply"}
                        onAccessPolicyChange={
                          task === "reply"
                            ? (policy) =>
                                change({
                                  ...draft,
                                  providerApprovalPolicies: {
                                    ...draft.providerApprovalPolicies,
                                    [selectedProvider]: policy,
                                  },
                                })
                            : undefined
                        }
                        disabled={isSaving}
                        labelPrefix={label}
                        aria-describedby={descriptionId}
                        className="h-9 w-fit"
                        onChange={(model, reasoning, provider) =>
                          updateSelection(
                            providerField,
                            modelField,
                            effortField,
                            model,
                            reasoning,
                            provider
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              )
            }
          )}
          <div className="space-y-4 px-4 py-5">
            <div>
              <h3 className="text-sm font-medium">Provider access</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Applies when chat uses Provider policy. Full access allows tools
                without review. Background tasks always use restricted policies.
              </p>
            </div>
            {AI_PROVIDER_OPTIONS.map((provider) => (
              <div
                key={provider.id}
                className="grid gap-2 sm:grid-cols-2 sm:items-center"
              >
                <label htmlFor={`approval-${provider.id}`} className="text-sm">
                  {provider.label}
                </label>
                <div>
                  <Select
                    value={resolveProviderApprovalPolicy(draft, provider.id)}
                    disabled={
                      isSaving ||
                      AI_PROVIDER_APPROVAL_POLICIES[provider.id].length === 1
                    }
                    onValueChange={(value) =>
                      change({
                        ...draft,
                        providerApprovalPolicies: {
                          ...draft.providerApprovalPolicies,
                          [provider.id]: value as AiApprovalPolicy,
                        },
                      })
                    }
                  >
                    <SelectTrigger
                      id={`approval-${provider.id}`}
                      className="h-10"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {AI_PROVIDER_APPROVAL_POLICIES[provider.id].map(
                        (policy) => (
                          <SelectItem key={policy} value={policy}>
                            {providerAccessChoice(provider.id, policy).label}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p
            aria-live="polite"
            className={
              feedback?.tone === "error" && !isSaving
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {isSaving
              ? "Saving…"
              : feedback?.tone === "error"
                ? feedback.message
                : feedback
                  ? `${feedback.message} They apply when Blitz starts its next AI turn.`
                  : "Changes save as you make them and apply when Blitz starts its next AI turn."}
          </p>
          {feedback?.tone === "error" && !isSaving ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void save(draft)}
              className="h-10 rounded-xl px-4"
            >
              Try again
            </Button>
          ) : null}
        </CardFooter>
      </Card>
    </div>
  )
}

/** Shows the settings form's structure while its persisted configuration loads. */
function ModelSettingsLoading() {
  return (
    <Card aria-busy="true" className="gap-0 py-0">
      <CardHeader className="border-b py-5">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="mt-2 h-4 w-full max-w-sm" />
      </CardHeader>
      <CardContent className="space-y-5 px-4 py-5">
        {MODEL_FIELDS.map(({ modelField }) => (
          <div key={modelField} className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-11 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
