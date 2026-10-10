/** Runs and persists local audiobook and podcast jobs inside each project directory. */

import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { ConvexHttpClient } from "convex/browser"
import { z } from "zod"

import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { resolveAiTaskSelection } from "@/lib/ai-model-settings"
import type {
  ProjectAudioItem,
  ProjectAudioKind,
  ProjectAudioSegment,
  ProjectAudioTranscript,
} from "@/lib/project-audio-types"
import { validateKokoroVoiceIds, type KokoroVoiceId } from "@/lib/kokoro-voices"
import { spokenAudioText, type AudioPronunciation } from "@/lib/spoken-audio"
import { loadSavedAiModelSettings } from "./ai-model-settings"
import { createAudiobookScript } from "./audiobook-script"
import { synthesizeKokoroToFile } from "./kokoro"
import { createPodcastScript, type PodcastSource } from "./podcast-script"
import { resolveProjectFile, storeProjectFile } from "./project-files"
import { extractStoredSource } from "./source-ingestion/extract"

/** One passage awaiting synthesis, with its stable speaker identity. */
type AudioPassage = {
  text: string
  spokenText: string
  pronunciations: AudioPronunciation[]
  voiceId: KokoroVoiceId
  speaker: ProjectAudioSegment["speaker"]
  pauseBeforeSeconds?: number
}

/** One measured WAV chunk and an optional section pause before it. */
type AudioPart = { path: string; pauseBeforeSeconds: number }

/** Validates on-disk transcript content before it reaches a client or model. */
const transcriptSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(["audiobook", "podcast"]),
  durationSeconds: z.number().positive(),
  segments: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        startSeconds: z.number().nonnegative(),
        endSeconds: z.number().positive(),
        text: z.string().min(1),
        spokenText: z.string().min(1).optional(),
        speaker: z.enum(["narrator", "host1", "host2"]),
      })
    )
    .min(1),
})

/** Private job snapshot kept beside the generated files. */
type AudioManifest = ProjectAudioItem & {
  projectId: string
  updatedAt: number
  workerPid: number
  voiceIds: KokoroVoiceId[]
  requestedMinutes?: 15 | 30 | 60 | 90
  focus?: string
}

/** Requests accepted by the project audio route after input validation. */
export type CreateProjectAudioInput = {
  kind: ProjectAudioKind
  sourceId?: string
  /** Limits a podcast to one unit's sources. */
  unitId?: string
  durationMinutes?: 15 | 30 | 60 | 90
  focus?: string
}

/** Process-local job state survives Next development module reloads. */
const audioProcessState = globalThis as typeof globalThis & {
  __blitzAudioJobs?: Map<string, Promise<void>>
  __blitzAudioStarts?: Set<string>
}
/** Active work in this local Next process; Kokoro serializes each speech chunk. */
const activeJobs = (audioProcessState.__blitzAudioJobs ??= new Map())
/** Prevents two near-simultaneous requests from starting jobs for one project. */
const startingProjects = (audioProcessState.__blitzAudioStarts ??= new Set())
/** Audio key names are random UUIDs, never client-provided paths. */
const AUDIO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Builds a Convex client for the currently running local Blitz deployment. */
export function localConvexClient(): ConvexHttpClient {
  const endpoint =
    process.env.BLITZ_CONVEX_URL ??
    process.env.NEXT_PUBLIC_CONVEX_URL ??
    process.env.CONVEX_URL
  if (!endpoint) throw new Error("The local project service is unavailable")
  return new ConvexHttpClient(endpoint)
}

/** Returns an item's response shape without leaking its private job details. */
function publicItem(manifest: AudioManifest): ProjectAudioItem {
  return {
    id: manifest.id,
    kind: manifest.kind,
    title: manifest.title,
    status: manifest.status,
    createdAt: manifest.createdAt,
    ...(manifest.durationMinutes === undefined
      ? {}
      : { durationMinutes: manifest.durationMinutes }),
    ...(manifest.error ? { error: manifest.error } : {}),
    ...(manifest.audioUrl ? { audioUrl: manifest.audioUrl } : {}),
    ...(manifest.sourceId ? { sourceId: manifest.sourceId } : {}),
    ...(manifest.stage ? { stage: manifest.stage } : {}),
    ...(manifest.completedChunks === undefined
      ? {}
      : { completedChunks: manifest.completedChunks }),
    ...(manifest.totalChunks === undefined
      ? {}
      : { totalChunks: manifest.totalChunks }),
  }
}

/** Resolves a manifest path only after validating its opaque audio ID. */
async function manifestPath(
  projectId: string,
  audioId: string
): Promise<string> {
  if (!AUDIO_ID_PATTERN.test(audioId)) throw new Error("Audio item is invalid")
  return resolveProjectFile(projectId, `Audio/${audioId}/job.json`)
}

/** Saves a job snapshot through the project's atomic file writer. */
async function writeManifest(manifest: AudioManifest): Promise<void> {
  manifest.updatedAt = Date.now()
  await storeProjectFile(
    manifest.projectId,
    `Audio/${manifest.id}/job.json`,
    JSON.stringify(manifest, null, 2)
  )
}

/** Reads a single manifest, rejecting mismatched or malformed project data. */
async function readManifest(
  projectId: string,
  audioId: string
): Promise<AudioManifest | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(await manifestPath(projectId, audioId), "utf8")
    ) as AudioManifest
    if (
      raw.id !== audioId ||
      raw.projectId !== projectId ||
      !["audiobook", "podcast"].includes(raw.kind)
    )
      return null
    return raw
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Reports whether the process that started an unfinished job still exists. */
function workerIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Marks interrupted local work as failed after its owning process exits. */
async function recoverInterrupted(
  manifest: AudioManifest
): Promise<AudioManifest> {
  if (
    (manifest.status === "queued" || manifest.status === "generating") &&
    !activeJobs.has(manifest.id) &&
    (!workerIsAlive(manifest.workerPid) ||
      Date.now() - manifest.updatedAt > 24 * 60 * 60 * 1000)
  ) {
    manifest.status = "failed"
    manifest.error =
      "Generation stopped when Blitz closed. Create the audio again."
    await writeManifest(manifest)
  }
  return manifest
}

/** Lists local recordings newest first without returning source text. */
export async function listProjectAudio(
  projectId: string
): Promise<ProjectAudioItem[]> {
  const directory = await resolveProjectFile(projectId, "Audio")
  let entries: string[]
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const items: ProjectAudioItem[] = []
  for (const audioId of entries.filter((entry) =>
    AUDIO_ID_PATTERN.test(entry)
  )) {
    const manifest = await readManifest(projectId, audioId)
    if (manifest) items.push(publicItem(await recoverInterrupted(manifest)))
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/** Returns one completed recording's checked local WAV path and public details. */
export async function completedProjectAudio(
  projectId: string,
  audioId: string
): Promise<{ path: string; item: ProjectAudioItem } | null> {
  const manifest = await readManifest(projectId, audioId)
  if (!manifest || manifest.status !== "completed") return null
  const path = await resolveProjectFile(
    projectId,
    `Audio/${audioId}/episode.wav`
  )
  await fs.access(path)
  return { path, item: publicItem(manifest) }
}

/** Loads the measured transcript for one completed recording. */
export async function completedProjectTranscript(
  projectId: string,
  audioId: string
): Promise<{
  item: ProjectAudioItem
  transcript: ProjectAudioTranscript
} | null> {
  const recording = await completedProjectAudio(projectId, audioId)
  if (!recording) return null
  const path = await resolveProjectFile(
    projectId,
    `Audio/${audioId}/transcript.json`
  )
  try {
    const raw = JSON.parse(await fs.readFile(path, "utf8")) as unknown
    const transcript = transcriptSchema.parse(raw)
    if (transcript.kind !== recording.item.kind)
      throw new Error("The recording transcript does not match its audio")
    return { item: recording.item, transcript }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/**
 * Lists the extracted text of every ready source the podcast should cover, so
 * coverage is not silently truncated. A unit podcast reads that unit's
 * sources; a module podcast reads every unit's sources plus unsorted ones.
 * Past papers, their solutions, and reference books are never taught, so they
 * are left out, matching `units.listForProject`.
 */
async function readyPodcastSources(
  client: ConvexHttpClient,
  projectId: Id<"projects">,
  unitId?: string
): Promise<PodcastSource[]> {
  let candidates: Array<{ id: Id<"sources">; status: string; hasText: boolean }>
  if (unitId) {
    const unit = await client.query(api.units.get, { unitId: unitId as Id<"units"> })
    candidates = unit?.sources ?? []
  } else {
    const learningPath = await client.query(api.units.listForProject, { projectId })
    candidates = [
      ...learningPath.units.flatMap((unit) => unit.sources),
      ...learningPath.unsortedSources,
    ]
  }
  const sources: PodcastSource[] = []
  for (const metadata of candidates) {
    if (metadata.status !== "ready" || !metadata.hasText) continue
    const source = await client.query(api.sources.getSource, {
      projectId,
      sourceId: metadata.id,
    })
    if (source?.extractedText.trim())
      sources.push({ filename: source.filename, text: source.extractedText })
  }
  return sources
}

/** Finds a pronunciation whose written phrase straddles two chunks. */
function pronunciationCrossesBoundary(
  left: string,
  right: string,
  pronunciations: readonly AudioPronunciation[]
): boolean {
  const joined = `${left} ${right}`
  return pronunciations.some(({ written }) => {
    if (!written.includes(" ")) return false
    let position = joined.indexOf(written)
    while (position >= 0) {
      if (position < left.length && position + written.length > left.length + 1)
        return true
      position = joined.indexOf(written, position + 1)
    }
    return false
  })
}

/** Splits speech near sentences without breaking a term's phonetic spelling. */
function speechChunks(
  text: string,
  maxLength = 360,
  pronunciations: readonly AudioPronunciation[] = []
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim()
  const sentences = normalized.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) ?? [
    normalized,
  ]
  const chunks: string[] = []
  let current = ""
  for (const sentence of sentences) {
    const trimmed = sentence.trim()
    if (current && current.length + trimmed.length + 1 > maxLength) {
      chunks.push(current)
      current = ""
    }
    const words = trimmed.split(/\s+/)
    for (const word of words) {
      if (word.length > maxLength) {
        if (current) chunks.push(current)
        current = ""
        for (const symbol of word) {
          if (current.length + symbol.length > maxLength) {
            chunks.push(current)
            current = ""
          }
          current += symbol
        }
        if (current) chunks.push(current)
        current = ""
        continue
      }
      if (current && current.length + word.length + 1 > maxLength) {
        chunks.push(current)
        current = ""
      }
      current += `${current ? " " : ""}${word}`
    }
  }
  if (current) chunks.push(current)
  const merged: string[] = []
  for (const chunk of chunks) {
    const previous = merged.at(-1)
    if (
      previous &&
      pronunciationCrossesBoundary(previous, chunk, pronunciations)
    )
      merged[merged.length - 1] = `${previous} ${chunk}`
    else merged.push(chunk)
  }
  return merged
}

/** Divides a measured WAV part into shorter follow-along passages without rerunning TTS. */
function timedPassages(
  passage: AudioPassage,
  startSeconds: number,
  durationSeconds: number,
  firstIndex: number
): ProjectAudioSegment[] {
  let lines = speechChunks(passage.text, 140, passage.pronunciations)
  let spokenLines = lines.map((line) =>
    spokenAudioText(line, passage.pronunciations)
  )
  // Keep the saved speech transcript exact if a rare term crosses a display split.
  if (spokenLines.join(" ") !== passage.spokenText) {
    lines = [passage.text]
    spokenLines = [passage.spokenText]
  }
  const weights = spokenLines.map((line) =>
    Math.max(1, line.replace(/\s/g, "").length)
  )
  const totalWeight = weights.reduce((total, weight) => total + weight, 0)
  let elapsedWeight = 0
  return lines.map((line, offset) => {
    const lineStart =
      startSeconds + (elapsedWeight / totalWeight) * durationSeconds
    elapsedWeight += weights[offset]
    return {
      index: firstIndex + offset,
      startSeconds: lineStart,
      endSeconds:
        offset === lines.length - 1
          ? startSeconds + durationSeconds
          : startSeconds + (elapsedWeight / totalWeight) * durationSeconds,
      text: line,
      spokenText: spokenLines[offset],
      speaker: passage.speaker,
    }
  })
}

/** Joins PCM parts with the Python standard library and an atomic rename. */
async function joinParts(
  outputPath: string,
  parts: AudioPart[]
): Promise<void> {
  const python = process.env.BLITZ_KOKORO_PYTHON?.trim() || "python3"
  const script = join(process.cwd(), "scripts", "join-wav.py")
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      /* turbopackIgnore: true */ python,
      [script, outputPath],
      {
        stdio: ["pipe", "ignore", "pipe"],
      }
    )
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000)
    })
    child.once("error", reject)
    child.once("exit", (code) => {
      if (code === 0) resolve()
      else
        reject(new Error(stderr.trim() || "Could not join the audio sections"))
    })
    child.stdin.end(JSON.stringify(parts))
  })
}

/** Reads the fixed PCM WAV header to report an actual duration after synthesis. */
async function wavMinutes(path: string): Promise<number> {
  const file = await fs.open(path, "r")
  try {
    const header = Buffer.alloc(44)
    await file.read(header, 0, header.length, 0)
    const bytesPerSecond = header.readUInt32LE(28)
    const dataBytes = header.readUInt32LE(40)
    if (!bytesPerSecond || !dataBytes)
      throw new Error("Generated audio is empty")
    return dataBytes / bytesPerSecond / 60
  } finally {
    await file.close()
  }
}

/** Re-reads a stored PDF so a newly improved page order helps older imports too. */
async function audiobookSourceText(
  projectId: string,
  source: {
    kind: string
    relativeKey?: string
    filename: string
    mimeType?: string
    sizeBytes?: number
    extractedText: string
  }
): Promise<string> {
  if (source.kind !== "pdf" || !source.relativeKey || !source.sizeBytes)
    return source.extractedText
  try {
    const original = await extractStoredSource({
      path: await resolveProjectFile(projectId, source.relativeKey),
      filename: source.filename,
      contentType: source.mimeType ?? null,
      sizeBytes: source.sizeBytes,
    })
    return original.extractedText
  } catch {
    // An older upload may no longer be readable, while its saved text is still usable.
    return source.extractedText
  }
}

/** Saves a spoken script grounded in the source before mapping it to one voice. */
async function audiobookPass(
  manifest: AudioManifest,
  client: ConvexHttpClient,
  projectId: Id<"projects">
): Promise<AudioPassage[]> {
  if (!manifest.sourceId) throw new Error("Choose a source for this audiobook")
  const source = await client.query(api.sources.getSource, {
    projectId,
    sourceId: manifest.sourceId as Id<"sources">,
  })
  if (!source || source.status !== "ready" || !source.extractedText.trim())
    throw new Error("The selected source is not ready for narration")
  const settings = await loadSavedAiModelSettings(client)
  const selection = resolveAiTaskSelection(settings, "research", {
    providerEnvironmentFallback: process.env.BLITZ_RESEARCH_PROVIDER,
    modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
    effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
  })
  const sections = await createAudiobookScript({
    sourceText: await audiobookSourceText(manifest.projectId, source),
    filename: source.filename,
    selection,
  })
  await storeProjectFile(
    manifest.projectId,
    `Audio/${manifest.id}/script.json`,
    JSON.stringify({ sourceId: manifest.sourceId, sections }, null, 2)
  )
  return sections.flatMap((section, sectionIndex) =>
    speechChunks(section.text, 360, section.pronunciations).map(
      (text, chunkIndex) => ({
        text,
        spokenText: spokenAudioText(text, section.pronunciations),
        pronunciations: section.pronunciations,
        voiceId: manifest.voiceIds[0],
        speaker: "narrator",
        pauseBeforeSeconds:
          sectionIndex > 0 && section.startsNewSection && chunkIndex === 0
            ? 0.8
            : 0,
      })
    )
  )
}

/** Writes the podcast script, then maps each host's turns to the selected voices. */
async function podcastPass(
  manifest: AudioManifest,
  client: ConvexHttpClient,
  projectId: Id<"projects">,
  projectTitle: string
): Promise<AudioPassage[]> {
  const sources = await readyPodcastSources(client, projectId, manifest.unitId)
  const settings = await loadSavedAiModelSettings(client)
  const selection = resolveAiTaskSelection(settings, "research", {
    providerEnvironmentFallback: process.env.BLITZ_RESEARCH_PROVIDER,
    modelEnvironmentFallback: process.env.BLITZ_CODEX_MODEL,
    effortEnvironmentFallback: process.env.BLITZ_CODEX_EFFORT,
  })
  const script = await createPodcastScript({
    sources,
    projectTitle,
    requestedMinutes: manifest.requestedMinutes ?? 15,
    focus: manifest.focus ?? "",
    hostCount: manifest.voiceIds.length as 1 | 2,
    selection,
  })
  manifest.title = script.title
  await writeManifest(manifest)
  await storeProjectFile(
    manifest.projectId,
    `Audio/${manifest.id}/script.json`,
    JSON.stringify(script, null, 2)
  )
  return script.turns.flatMap((turn) =>
    speechChunks(turn.text, 360, turn.pronunciations).map((text) => ({
      text,
      spokenText: spokenAudioText(text, turn.pronunciations),
      pronunciations: turn.pronunciations,
      voiceId:
        turn.speaker === "host2" && manifest.voiceIds[1]
          ? manifest.voiceIds[1]
          : manifest.voiceIds[0],
      speaker: turn.speaker,
    }))
  )
}

/** Runs a queued job, preserving progress and a useful error after failure. */
async function runProjectAudio(
  manifest: AudioManifest,
  client: ConvexHttpClient,
  projectId: Id<"projects">,
  projectTitle: string
): Promise<void> {
  try {
    manifest.status = "generating"
    manifest.stage = manifest.kind === "podcast" ? "writing" : "adapting"
    await writeManifest(manifest)
    const passages =
      manifest.kind === "audiobook"
        ? await audiobookPass(manifest, client, projectId)
        : await podcastPass(manifest, client, projectId, projectTitle)
    if (!passages.length) throw new Error("There was no text to narrate")
    manifest.stage = "recording"
    manifest.completedChunks = 0
    manifest.totalChunks = passages.length
    await writeManifest(manifest)
    const parts: AudioPart[] = []
    const segments: ProjectAudioSegment[] = []
    for (const [index, passage] of passages.entries()) {
      const path = await resolveProjectFile(
        manifest.projectId,
        `Audio/${manifest.id}/parts/${String(index + 1).padStart(4, "0")}.wav`
      )
      await synthesizeKokoroToFile({
        text: passage.spokenText,
        voiceId: passage.voiceId,
        outputPath: path,
      })
      const pauseBeforeSeconds = passage.pauseBeforeSeconds ?? 0
      parts.push({ path, pauseBeforeSeconds })
      const startSeconds =
        (segments.at(-1)?.endSeconds ?? 0) + pauseBeforeSeconds
      segments.push(
        ...timedPassages(
          passage,
          startSeconds,
          (await wavMinutes(path)) * 60,
          segments.length
        )
      )
      manifest.completedChunks = index + 1
      if (index % 3 === 2 || index === passages.length - 1)
        await writeManifest(manifest)
    }
    manifest.stage = "finishing"
    await writeManifest(manifest)
    const outputPath = await resolveProjectFile(
      manifest.projectId,
      `Audio/${manifest.id}/episode.wav`
    )
    await joinParts(outputPath, parts)
    const durationSeconds = (await wavMinutes(outputPath)) * 60
    const transcript: ProjectAudioTranscript = {
      title: manifest.title,
      kind: manifest.kind,
      durationSeconds,
      segments,
    }
    await storeProjectFile(
      manifest.projectId,
      `Audio/${manifest.id}/transcript.json`,
      JSON.stringify(transcript)
    )
    manifest.durationMinutes = durationSeconds / 60
    manifest.audioUrl = `/api/projects/${encodeURIComponent(manifest.projectId)}/audio/${manifest.id}/file`
    manifest.status = "completed"
    manifest.stage = undefined
    manifest.error = undefined
    await writeManifest(manifest)
    await fs.rm(
      await resolveProjectFile(
        manifest.projectId,
        `Audio/${manifest.id}/parts`
      ),
      {
        recursive: true,
        force: true,
      }
    )
  } catch (error) {
    manifest.status = "failed"
    manifest.stage = undefined
    manifest.error =
      error instanceof Error ? error.message : "Audio generation failed"
    await writeManifest(manifest)
  }
}

/** Validates the selected source and starts one local job without holding the HTTP request open. */
export async function createProjectAudio(
  projectId: string,
  projectTitle: string,
  client: ConvexHttpClient,
  input: CreateProjectAudioInput
): Promise<ProjectAudioItem> {
  if (startingProjects.has(projectId))
    throw new Error("Wait for the current project audio to start")
  startingProjects.add(projectId)
  try {
    const existing = await listProjectAudio(projectId)
    if (
      existing.some(
        (item) => item.status === "queued" || item.status === "generating"
      )
    )
      throw new Error("Wait for the current project audio to finish")
    let sourceFilename: string | undefined
    let unitTitle: string | undefined
    if (input.kind === "podcast" && input.unitId) {
      const unit = await client.query(api.units.get, { unitId: input.unitId as Id<"units"> })
      if (!unit || unit.projectId !== projectId)
        throw new Error("Choose a unit from this module")
      if (!unit.sources.some((source) => source.hasText))
        throw new Error("This unit has no readable material yet")
      unitTitle = unit.title
    }
    if (input.kind === "audiobook") {
      if (!input.sourceId) throw new Error("Choose a source for the audiobook")
      const source = await client.query(api.sources.getSource, {
        projectId: projectId as Id<"projects">,
        sourceId: input.sourceId as Id<"sources">,
      })
      if (!source || source.status !== "ready" || !source.extractedText.trim())
        throw new Error("Choose a ready source with readable text")
      sourceFilename = source.filename
    }
    const saved = await client.query(api.audioSettings.get, {})
    const voiceIds = validateKokoroVoiceIds(saved?.voiceIds ?? ["af_heart"])
    const now = Date.now()
    const id = randomUUID()
    const manifest: AudioManifest = {
      id,
      projectId,
      kind: input.kind,
      title:
        input.kind === "audiobook"
          ? `${sourceFilename} audiobook`
          : `${unitTitle ?? projectTitle} podcast`,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      workerPid: process.pid,
      voiceIds,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      ...(input.kind === "podcast" && input.unitId ? { unitId: input.unitId } : {}),
      ...(input.durationMinutes
        ? {
            requestedMinutes: input.durationMinutes,
            durationMinutes: input.durationMinutes,
          }
        : {}),
      ...(input.focus ? { focus: input.focus } : {}),
    }
    await writeManifest(manifest)
    const job = runProjectAudio(
      manifest,
      client,
      projectId as Id<"projects">,
      projectTitle
    )
    activeJobs.set(id, job)
    void job.then(
      () => activeJobs.delete(id),
      () => activeJobs.delete(id)
    )
    return publicItem(manifest)
  } finally {
    startingProjects.delete(projectId)
  }
}
