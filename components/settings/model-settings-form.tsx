"use client"

/** Owns the editable, persisted model choices for each AI task in Blitz. */

import { useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { api } from "@/convex/_generated/api"
import {
  DEFAULT_AI_MODELS,
  validateAiModelSettings,
  type AiModelField,
  type AiModelSettings,
} from "@/lib/ai-model-settings"

/** One user-facing model setting and the AI operation it controls. */
const MODEL_FIELDS: Array<{
  field: AiModelField
  label: string
  description: string
}> = [
  {
    field: "researchModel",
    label: "Research",
    description: "Plans research and looks for sources to learn from.",
  },
  {
    field: "cardGenerationModel",
    label: "Card generation",
    description: "Turns uploaded and approved source material into study cards.",
  },
  {
    field: "replyModel",
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
      key={JSON.stringify(savedSettings ?? DEFAULT_AI_MODELS)}
      initialSettings={{ ...(savedSettings ?? DEFAULT_AI_MODELS) }}
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

  /** Updates one task's local model choice and makes the pending change visible. */
  const updateDraft = (field: AiModelField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }))
    setIsDirty(true)
    setFeedback(null)
  }

  /** Validates the complete form, then persists all choices in one Convex mutation. */
  const save = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
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
            : "Enter a valid model for every task.",
      })
      return
    }
    setIsSaving(true)
    setFeedback(null)
    try {
      const saved = await saveSettings(settings)
      setDraft(saved)
      setIsDirty(false)
      setFeedback({ tone: "success", message: "Model settings saved." })
    } catch {
      setFeedback({
        tone: "error",
        message: "Could not save model settings. Try again.",
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <form onSubmit={save}>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-5">
          <CardTitle>Model choices</CardTitle>
          <CardDescription>
            Use model IDs available in the Codex account running your local
            workers.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y px-0">
          {MODEL_FIELDS.map(({ field, label, description }) => {
            const inputId = `ai-model-${field}`
            const descriptionId = `${inputId}-description`
            return (
              <div
                key={field}
                className="grid gap-3 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_minmax(13rem,18rem)] sm:items-center sm:gap-6"
              >
                <div>
                  <label htmlFor={inputId} className="text-sm font-medium">
                    {label}
                  </label>
                  <p
                    id={descriptionId}
                    className="mt-1 text-sm leading-5 text-muted-foreground"
                  >
                    {description}
                  </p>
                </div>
                <Input
                  id={inputId}
                  value={draft[field]}
                  onChange={(event) => updateDraft(field, event.target.value)}
                  aria-describedby={descriptionId}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={120}
                  className="h-11 font-mono text-sm"
                />
              </div>
            )
          })}
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
            {isSaving ? "Saving models" : "Save models"}
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
        {MODEL_FIELDS.map(({ field }) => (
          <div key={field} className="space-y-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-11 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
