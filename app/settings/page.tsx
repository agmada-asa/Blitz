/** Presents application-wide appearance and AI settings for Blitz. */

import { AppearanceSettings } from "@/components/settings/appearance-settings"
import { KokoroVoiceSettings } from "@/components/settings/kokoro-voice-settings"
import { ModelSettingsForm } from "@/components/settings/model-settings-form"
import { ProviderConnections } from "@/components/settings/provider-connections"

/** Renders the settings route and groups appearance choices above AI settings. */
export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <div className="mb-8 max-w-2xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          Settings
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Customize how Blitz looks, sounds, and helps you study.
        </p>
      </div>
      <div className="space-y-10">
        <section aria-labelledby="appearance-heading" className="space-y-4">
          <div>
            <h2
              id="appearance-heading"
              className="font-heading text-xl font-medium tracking-tight"
            >
              Appearance
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Choose the theme and accent colour for Blitz.
            </p>
          </div>
          <AppearanceSettings />
        </section>
        <section aria-labelledby="audio-settings-heading" className="space-y-4">
          <div>
            <h2
              id="audio-settings-heading"
              className="font-heading text-xl font-medium tracking-tight"
            >
              Audio
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Choose the voices for narrated study material and podcasts.
            </p>
          </div>
          <KokoroVoiceSettings />
        </section>
        <section aria-labelledby="ai-settings-heading" className="space-y-4">
          <div>
            <h2
              id="ai-settings-heading"
              className="font-heading text-xl font-medium tracking-tight"
            >
              AI settings
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Choose the models and reasoning levels Blitz uses for research,
              card generation, and replies.
            </p>
          </div>
          <ProviderConnections />
          <ModelSettingsForm />
        </section>
      </div>
    </main>
  )
}
