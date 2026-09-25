"use client"

/** Lets users preview Kokoro voices and save one or two podcast host choices. */

import { useState } from "react"
import { useMutation, useQuery } from "convex/react"

import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  KOKORO_VOICES,
  validateKokoroVoiceIds,
  type KokoroVoiceId,
} from "@/lib/kokoro-voices"

/** Default host shown before the user saves a preference. */
const DEFAULT_HOST_VOICES: KokoroVoiceId[] = ["af_heart"]

/** Renders Kokoro's fixed model label and the saved podcast host voice choices. */
export function KokoroVoiceSettings() {
  const settings = useQuery(api.audioSettings.get)
  if (settings === undefined) return <KokoroVoiceSettingsLoading />

  return (
    <KokoroVoiceEditor
      key={JSON.stringify(settings?.voiceIds ?? DEFAULT_HOST_VOICES)}
      initialVoiceIds={settings?.voiceIds ?? DEFAULT_HOST_VOICES}
    />
  )
}

/** Shows placeholders while Convex loads the saved voice choices. */
function KokoroVoiceSettingsLoading() {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-4 p-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </CardContent>
    </Card>
  )
}

/** Edits one ordered host selection and reports save or validation results. */
function KokoroVoiceEditor({
  initialVoiceIds,
}: {
  initialVoiceIds: KokoroVoiceId[]
}) {
  const saveSettings = useMutation(api.audioSettings.save)
  const [voiceIds, setVoiceIds] = useState(initialVoiceIds)
  const [isSaving, setIsSaving] = useState(false)
  const [feedback, setFeedback] = useState<{
    tone: "error" | "success"
    message: string
  } | null>(null)
  const isDirty = JSON.stringify(voiceIds) !== JSON.stringify(initialVoiceIds)

  /** Adds or removes a host while preserving the order in which hosts were picked. */
  const toggleVoice = (voiceId: KokoroVoiceId, checked: boolean): void => {
    setFeedback(null)
    setVoiceIds((current) => {
      if (checked) return current.length < 2 ? [...current, voiceId] : current
      return current.filter((id) => id !== voiceId)
    })
  }

  /** Validates and persists the selected host order in one Convex mutation. */
  const save = async (): Promise<void> => {
    if (isSaving || !isDirty) return
    let validatedVoiceIds: KokoroVoiceId[]
    try {
      validatedVoiceIds = validateKokoroVoiceIds(voiceIds)
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Choose one or two different voices.",
      })
      return
    }
    setIsSaving(true)
    setFeedback(null)
    try {
      await saveSettings({ voiceIds: validatedVoiceIds })
      setFeedback({ tone: "success", message: "Podcast voices saved." })
    } catch (error) {
      setFeedback({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not save podcast voices. Try again.",
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card className="gap-0 py-0">
      <CardContent className="divide-y px-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <p className="text-sm font-medium">Speech model</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Kokoro · runs on this Mac
            </p>
          </div>
          <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            Kokoro
          </span>
        </div>
        <div className="px-4 py-4">
          <h3 className="text-sm font-medium">Podcast hosts</h3>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            Preview each voice, then choose one or two in host order.
          </p>
          <div className="mt-4 divide-y rounded-lg border">
            {KOKORO_VOICES.map((voice) => {
              const hostIndex = voiceIds.indexOf(voice.id)
              const selected = hostIndex >= 0
              const disabled = !selected && voiceIds.length === 2
              return (
                <div
                  key={voice.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-4"
                >
                  <Checkbox
                    id={`kokoro-voice-${voice.id}`}
                    checked={selected}
                    disabled={disabled}
                    onCheckedChange={(value) =>
                      toggleVoice(voice.id, value === true)
                    }
                    aria-label={`Use ${voice.name} as a podcast host`}
                  />
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor={`kokoro-voice-${voice.id}`}
                      className="cursor-pointer text-sm font-medium"
                    >
                      {voice.name}
                      {selected ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          Host {hostIndex + 1}
                        </span>
                      ) : null}
                    </label>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {voice.description}
                    </p>
                  </div>
                  <audio
                    controls
                    preload="none"
                    className="col-span-2 h-9 w-full sm:col-span-1 sm:w-52"
                    src={`/audio/voices/${voice.id}.mp3`}
                    aria-label={`Preview ${voice.name} voice`}
                  >
                    Your browser does not support audio playback.
                  </audio>
                </div>
              )
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={save}
              disabled={!isDirty || isSaving || voiceIds.length < 1}
            >
              {isSaving ? "Saving…" : "Save podcast voices"}
            </Button>
            {feedback ? (
              <p
                role={feedback.tone === "error" ? "alert" : "status"}
                className={
                  feedback.tone === "error"
                    ? "text-sm text-destructive"
                    : "text-sm text-muted-foreground"
                }
              >
                {feedback.message}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
