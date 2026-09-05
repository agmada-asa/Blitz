"use client"

/** Owns the editable, persisted model and reasoning choices for each AI task in Blitz. */

import { useState, type FormEvent } from "react"
import { useMutation, useQuery } from "convex/react"

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
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODEL_SETTINGS,
  DEFAULT_AI_REASONING_EFFORTS,
  getCodexModelPickerOptions,
  getSupportedAiReasoningEfforts,
  validateAiModelSettings,
  type AiModelField,
  type AiModelSettings,
  type AiReasoningEffort,
  type AiReasoningField,
} from "@/lib/ai-model-settings"

/** One user-facing AI setting and the task it controls. */
const MODEL_FIELDS: Array<{
  modelField: AiModelField
  effortField: AiReasoningField
  label: string
  description: string
}> = [
  {
    modelField: "researchModel",
    effortField: "researchEffort",
    label: "Research",
    description: "Plans research and looks for sources to learn from.",
  },
  {
    modelField: "cardGenerationModel",
    effortField: "cardGenerationEffort",
    label: "Card generation",
    description:
      "Turns uploaded and approved source material into study cards.",
  },
  {
    modelField: "replyModel",
    effortField: "replyEffort",
    label: "Replies",
    description: "Answers questions you ask about an individual study card.",
  },
]

/** Copy and intent for the save result announced to assistive technology. */
type SaveFeedback = { tone: "error" | "success"; message: string } | null

/** Formats a machine-readable effort value for a compact picker label. */
function reasoningLabel(effort: AiReasoningEffort): string {
  return effort === "xhigh"
    ? "Extra high"
    : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`
}

/** Renders saved model fields and submits a complete update as one configuration. */
export function ModelSettingsForm() {
  const savedSettings = useQuery(api.settings.get)
  if (savedSettings === undefined) return <ModelSettingsLoading />

  return (
    <ModelSettingsEditor
      key={JSON.stringify(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS)}
      initialSettings={{ ...(savedSettings ?? DEFAULT_AI_MODEL_SETTINGS) }}
    />
  )
}

/** Edits one stable settings snapshot and resets only after Convex reports a new saved value. */
function ModelSettingsEditor({
  initialSettings,
}: {
  initialSettings: AiModelSettings
}) {
  const saveSettings = useMutation(api.settings.save)
  const [draft, setDraft] = useState<AiModelSettings>(initialSettings)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [feedback, setFeedback] = useState<SaveFeedback>(null)

  /** Marks a local change as pending and clears older save feedback. */
  const markDirty = (): void => {
    setIsDirty(true)
    setFeedback(null)
  }

  /** Updates one task's model and resets its reasoning only when the new model requires it. */
  const updateModel = (
    modelField: AiModelField,
    effortField: AiReasoningField,
    model: string
  ): void => {
    setDraft((current) => {
      const supportedEfforts = getSupportedAiReasoningEfforts(model)
      const effort = supportedEfforts.includes(current[effortField])
        ? current[effortField]
        : DEFAULT_AI_REASONING_EFFORTS[effortField]
      return { ...current, [modelField]: model, [effortField]: effort }
    })
    markDirty()
  }

  /** Updates one task's local reasoning choice and makes the pending change visible. */
  const updateReasoning = (
    field: AiReasoningField,
    effort: AiReasoningEffort
  ): void => {
    setDraft((current) => ({ ...current, [field]: effort }))
    markDirty()
  }

  /** Validates the complete form, then persists all choices in one Convex mutation. */
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (isSaving) return
    let settings: AiModelSettings
    try {
      settings = validateAiModelSettings(draft)
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Choose a valid model and reasoning level for every task.",
      })
      return
    }
    setIsSaving(true)
    setFeedback(null)
    try {
      const saved = await saveSettings(settings)
      setDraft(saved)
      setIsDirty(false)
      setFeedback({ tone: "success", message: "AI settings saved." })
    } catch {
      setFeedback({
        tone: "error",
        message: "Could not save AI settings. Try again.",
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form onSubmit={save}>
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
            ({ modelField, effortField, label, description }) => {
              const inputId = `ai-model-${modelField}`
              const descriptionId = `${inputId}-description`
              const modelId = `${inputId}-picker`
              const effortId = `${inputId}-reasoning`
              const selectedModel = draft[modelField]
              const selectedEffort = draft[effortField]
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
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <label htmlFor={modelId} className="text-xs font-medium">
                        Model
                      </label>
                      <Select
                        value={selectedModel}
                        onValueChange={(value) =>
                          updateModel(modelField, effortField, value)
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger
                          id={modelId}
                          aria-describedby={descriptionId}
                          className="h-11"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {getCodexModelPickerOptions(selectedModel).map(
                            (option) => (
                              <SelectItem key={option.id} value={option.id}>
                                {option.label}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor={effortId} className="text-xs font-medium">
                        Reasoning
                      </label>
                      <Select
                        value={selectedEffort}
                        onValueChange={(value) =>
                          updateReasoning(
                            effortField,
                            value as AiReasoningEffort
                          )
                        }
                        disabled={isSaving}
                      >
                        <SelectTrigger
                          id={effortId}
                          aria-describedby={descriptionId}
                          className="h-11"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {getSupportedAiReasoningEfforts(selectedModel).map(
                            (effort) => (
                              <SelectItem key={effort} value={effort}>
                                {reasoningLabel(effort)}
                              </SelectItem>
                            )
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              )
            }
          )}
        </CardContent>
        <CardFooter className="flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <p
            aria-live="polite"
            className={
              feedback?.tone === "error"
                ? "text-sm text-destructive"
                : "text-sm text-muted-foreground"
            }
          >
            {feedback?.message ??
              (isDirty
                ? "Unsaved changes"
                : "Changes apply when Blitz starts its next AI turn.")}
          </p>
          <Button
            type="submit"
            disabled={isSaving || !isDirty}
            className="h-10 rounded-xl bg-brand px-4 text-brand-foreground hover:bg-brand/85"
          >
            {isSaving ? "Saving AI settings" : "Save AI settings"}
          </Button>
        </CardFooter>
      </Card>
    </form>
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
