"use client"

/** Owns the editable, persisted model and reasoning choices for each AI task in Blitz. */

import { useState, type FormEvent } from "react"
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
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODEL_SETTINGS,
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

  /** Updates one task's local model and reasoning pair without saving yet. */
  const updateSelection = (
    modelField: AiModelField,
    effortField: AiReasoningField,
    model: string,
    reasoning: AiReasoningEffort
  ): void => {
    setDraft((current) => ({
      ...current,
      [modelField]: model,
      [effortField]: reasoning,
    }))
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
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium">
                      Model and reasoning
                    </span>
                    <ModelReasoningPicker
                      model={selectedModel}
                      reasoning={selectedEffort}
                      disabled={isSaving}
                      labelPrefix={label}
                      aria-describedby={descriptionId}
                      className="h-11 w-full max-w-none justify-between rounded-lg border border-input bg-transparent px-3 text-sm text-foreground hover:bg-muted dark:bg-input/30"
                      onChange={(model, reasoning) =>
                        updateSelection(
                          modelField,
                          effortField,
                          model,
                          reasoning
                        )
                      }
                    />
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
            <Skeleton className="h-11 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
