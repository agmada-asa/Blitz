/** Generates schema-validated study sets through the selected Blitz provider. */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildGenerationPrompt, parseGenerationOutput } from "./codex.ts"
import { runProviderTextTurn } from "./providers/run-text-turn.ts"
import type { ProviderSelection } from "./providers/types.ts"
import type { Generation } from "./generate-schema.ts"

/** Generates one study set in an isolated, read-only provider workspace. */
export async function generateStudySetWithProvider(
  filename: string,
  text: string,
  selection: ProviderSelection,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<Generation> {
  const directory = await mkdtemp(join(tmpdir(), "blitz-generation-"))
  try {
    const result = await runProviderTextTurn({
      providerId: selection.providerId,
      ...(selection.providerInstanceId
        ? { providerInstanceId: selection.providerInstanceId }
        : {}),
      model: selection.model,
      ...(selection.effort === undefined ? {} : { effort: selection.effort }),
      workspaceDirectory: directory,
      prompt: buildGenerationPrompt(filename, text),
      ephemeral: true,
      webSearchMode: "disabled",
      sandbox: "read-only",
      approvalPolicy: "never",
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 120_000,
    })
    return parseGenerationOutput(result.text)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
