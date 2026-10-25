/**
 * Keeps the Codex and Claude Code threads behind chats tidy: each takes its
 * chat's title, so the runtimes' own apps list it by name rather than by the
 * first prompt, and a deleted chat's thread is deleted too.
 *
 * Convex queues the work when a chat is bound to a new thread, renamed, or
 * deleted (`runtimeThreadJobs` in `convex/workspaceChats.ts`), so it survives
 * a restart and needs no change to how chats are deleted. The background
 * worker (`scripts/worker.ts`) runs `runRuntimeThreadStep` in a loop. Each
 * step opens at most one engine per provider and closes it afterwards.
 * Background turns are ephemeral and leave no thread, so they never appear.
 */

import type { Engine } from "agent-engines"

import {
  createProviderEngine,
  type EngineProviderId,
} from "./providers/engines.ts"

/** One queued job, as `workspaceChats.runtimeThreadJobs` returns it. */
export type RuntimeThreadJob = {
  jobId: string
  kind: "rename" | "delete"
  providerId: string
  threadId: string
  chatId?: string
  projectId?: string
  title?: string
}

/** The Convex calls one step makes; the worker passes the real ones. */
export type RuntimeThreadQueue = {
  /** Oldest jobs first. */
  next: (limit: number) => Promise<RuntimeThreadJob[]>
  /** Records a job's outcome; a failed job is retried a few times, then dropped. */
  finish: (jobId: string, failed: boolean) => Promise<void>
}

/** Folders a thread can run in, resolved the way the chat route resolves them. */
export type RuntimeThreadFolders = {
  /** A project's folder, for Teach sessions and project agents. */
  project: (projectId: string) => string
  /** A general chat's own folder. */
  chat: (chatId: string) => string
}

/** Jobs handled per step. */
const BATCH = 10

/** Wait after a step that found work, in milliseconds. */
const BUSY_WAIT_MS = 2_000

/** Wait after an empty step, in milliseconds. */
const IDLE_WAIT_MS = 30_000

/**
 * Returns the folder a job's thread runs in. Claude Code renames a session
 * inside its folder's transcript list; Codex and deletions ignore the folder.
 */
function jobFolder(
  job: RuntimeThreadJob,
  folders: RuntimeThreadFolders
): string {
  if (job.projectId) return folders.project(job.projectId)
  return folders.chat(job.chatId ?? job.threadId)
}

/**
 * Runs one batch of queued jobs.
 *
 * @param queue Convex reads and writes.
 * @param folders Folder resolution for renames.
 * @param createEngine Opens a provider's engine; tests pass a fake.
 * @returns How long the worker should wait before the next step.
 */
export async function runRuntimeThreadStep(
  queue: RuntimeThreadQueue,
  folders: RuntimeThreadFolders,
  createEngine: (providerId: EngineProviderId) => Engine = createProviderEngine
): Promise<number> {
  const jobs = await queue.next(BATCH)
  if (!jobs.length) return IDLE_WAIT_MS
  const engines = new Map<EngineProviderId, Engine>()
  try {
    for (const job of jobs) {
      let failed = false
      try {
        if (job.providerId !== "codex" && job.providerId !== "claude-code")
          throw new Error(`Threads on ${job.providerId} cannot be tidied`)
        let engine = engines.get(job.providerId)
        if (!engine) {
          engine = createEngine(job.providerId)
          engines.set(job.providerId, engine)
        }
        const cwd = jobFolder(job, folders)
        if (job.kind === "delete")
          await engine.deleteThread(job.threadId, { cwd })
        else if (job.title)
          await engine.renameThread(job.threadId, job.title, { cwd })
      } catch (error) {
        failed = true
        console.error("A runtime thread could not be tidied", {
          kind: job.kind,
          providerId: job.providerId,
          message: error instanceof Error ? error.message : "Unknown error",
        })
      }
      await queue.finish(job.jobId, failed)
    }
  } finally {
    await Promise.all(
      [...engines.values()].map((engine) =>
        engine.close().catch(() => undefined)
      )
    )
  }
  return BUSY_WAIT_MS
}
