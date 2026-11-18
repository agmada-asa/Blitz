/**
 * Presents application-wide settings for Blitz. Each group has its label on the left and its
 * controls on the right; the longer voice and AI blocks fold behind a row that opens.
 */

import { AppearanceSettings } from "@/components/settings/appearance-settings"
import { DesktopLinkSettings } from "@/components/settings/desktop-link-settings"
import { KokoroVoiceSettings } from "@/components/settings/kokoro-voice-settings"
import { ModelSettingsForm } from "@/components/settings/model-settings-form"
import { ProviderConnections } from "@/components/settings/provider-connections"
import { SettingsFold } from "@/components/settings/settings-fold"
import { SettingsGroup } from "@/components/settings/settings-group"
import { StudyGoalSettings } from "@/components/settings/study-goal-settings"

/** Renders the settings route: daily goal, appearance, desktop app, audio, then AI. */
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
      <div>
        <SettingsGroup
          id="study-heading"
          title="Daily goal"
          description="Reaching your goal keeps your streak going. Correct answers earn 10 XP, wrong answers 4, and each taught section 25."
        >
          <StudyGoalSettings />
        </SettingsGroup>
        <SettingsGroup
          id="appearance-heading"
          title="Appearance"
          description="Choose the theme and accent colour for Blitz."
        >
          <AppearanceSettings />
        </SettingsGroup>
        <DesktopLinkSettings />
        <SettingsGroup
          id="audio-settings-heading"
          title="Audio"
          description="Choose the voices for narrated study material and podcasts."
        >
          <SettingsFold title="Voices" summary="Speech model and podcast hosts">
            <KokoroVoiceSettings />
          </SettingsFold>
        </SettingsGroup>
        <SettingsGroup
          id="ai-settings-heading"
          title="AI settings"
          description="Choose the models and reasoning levels Blitz uses for research, teaching and chat, and practice questions."
        >
          <SettingsFold
            title="Provider connections"
            summary="Accounts, spending limits and which agents Blitz can use"
          >
            <ProviderConnections />
          </SettingsFold>
          <SettingsFold
            title="Model and reasoning choices"
            summary="A model and reasoning level for each task"
          >
            <ModelSettingsForm />
          </SettingsFold>
        </SettingsGroup>
      </div>
    </main>
  )
}
