/** Exercises audiobook and podcast validation with a provider that still returns syllable overrides. */

import assert from "node:assert/strict"
import test from "node:test"

/** Loads the real script generators with queued provider responses and no external calls. */
async function loadScriptGenerators() {
  type Context = { parentURL?: string }
  type Result = { url: string; shortCircuit?: boolean }
  type Resolve = (specifier: string, context: Context) => Result
  const { registerHooks } = (await import("node:module")) as unknown as {
    registerHooks: (hooks: {
      resolve: (specifier: string, context: Context, next: Resolve) => Result
    }) => { deregister: () => void }
  }
  const providerUrl = `data:text/javascript,${encodeURIComponent(`
    export const responses = [];
    /** Returns one queued response without invoking an external provider. */
    export async function runProviderTextTurn() {
      if (!responses.length) throw new Error("Unexpected provider call");
      return { text: JSON.stringify(responses.shift()) };
    }
  `)}`
  const hooks = registerHooks({
    /** Replaces only the provider boundary and resolves extensionless local imports. */
    resolve(specifier, context, next) {
      if (specifier === "./providers/run-text-turn")
        return { url: providerUrl, shortCircuit: true }
      try {
        return next(specifier, context)
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts"))
          return next(`${specifier}.ts`, context)
        throw error
      }
    },
  })
  try {
    const provider = (await import(providerUrl)) as {
      responses: unknown[]
    }
    const { createAudiobookScript } =
      await import("../lib/server/audiobook-script.ts")
    const { createPodcastScript } =
      await import("../lib/server/podcast-script.ts")
    return { provider, createAudiobookScript, createPodcastScript }
  } finally {
    hooks.deregister()
  }
}

test("audiobooks and podcasts discard unsolicited model pronunciation overrides", async () => {
  const { provider, createAudiobookScript, createPodcastScript } =
    await loadScriptGenerators()
  const text = "Registers store binary data behind an interface."
  const pronunciations = [
    { written: "Registers", spoken: "rej iss ters" },
    { written: "binary", spoken: "bye nuh ree" },
    { written: "interface", spoken: "in ter face" },
  ]
  const selection = { providerId: "codex" as const, model: "fixture" }
  provider.responses.push({ sections: [{ text, pronunciations }] })
  const sections = await createAudiobookScript({
    sourceText: text,
    filename: "Architecture.txt",
    selection,
  })
  assert.equal(sections[0].spokenText, text)
  assert.equal("pronunciations" in sections[0], false)

  const dialogue = Array(100).fill(text).join(" ")
  provider.responses.push(
    {
      title: "Architecture",
      sections: Array.from({ length: 3 }, () => ({
        title: "Registers",
        coverage: "Binary storage and interfaces",
      })),
    },
    ...Array.from({ length: 3 }, () => ({
      turns: [{ speaker: "host1", text: dialogue, pronunciations }],
    }))
  )
  const podcast = await createPodcastScript({
    sources: [{ filename: "Architecture.txt", text }],
    projectTitle: "Architecture",
    requestedMinutes: 15,
    focus: "",
    hostCount: 1,
    selection,
  })
  assert.equal(podcast.turns.length, 3)
  for (const turn of podcast.turns) {
    assert.equal(turn.spokenText, dialogue)
    assert.equal("pronunciations" in turn, false)
  }
  assert.equal(provider.responses.length, 0)
})
