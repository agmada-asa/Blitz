/** Presents application-wide choices for the models that power Blitz's AI tasks. */

import { ModelSettingsForm } from "@/components/settings/model-settings-form"

/** Renders the model settings route and explains when changes take effect. */
export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <div className="mb-8 max-w-2xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          AI settings
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose the Codex model Blitz uses for research, card generation, and
          replies.
        </p>
      </div>
      <ModelSettingsForm />
    </main>
  )
}
