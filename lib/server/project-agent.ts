/**
 * Enforces the filesystem and network policy for one project agent.
 *
 * Agent execution is disabled until the host can enforce its isolation policy. The
 * policy intentionally excludes Sources and .blitz from writable artifacts;
 * callers must use the explicit promotion operation to create a source.
 */
import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  ensureProjectDirectory,
  getProjectDirectory,
  normalizeProjectFileKey,
} from "./project-files.ts"

/** Directory containing original uploads, which an agent may only inspect. */
export const PROJECT_SOURCES_DIRECTORY = "Sources"
/** Directory reserved for application state and metadata. */
export const PROJECT_STATE_DIRECTORY = ".blitz"
/** Maximum artifact size included in one scan. */
export const MAX_AGENT_ARTIFACT_BYTES = 25 * 1024 * 1024

/** A filesystem artifact exposed to Convex without exposing its contents. */
export interface ProjectArtifactSnapshot {
  relativeKey: string
  kind: "file" | "directory"
  sizeBytes?: number
  contentHash?: string
}

/** Agent launch policy, kept separate so the API cannot silently widen it. */
export interface ProjectAgentPolicy {
  projectId: string
  projectDirectory: string
  network: "disabled" | "research"
  sandbox: "workspace-write"
}

/** Result of one completed native agent task and its post-run artifact snapshot. */
export interface ProjectAgentRunResult {
  threadId: string
  turnId: string
  response: string
  artifacts: ProjectArtifactSnapshot[]
}

/** Returns the path used by one project agent after creating its safe folders. */
export async function prepareProjectAgentWorkspace(
  projectId: string,
  title?: string
): Promise<ProjectAgentPolicy> {
  const projectDirectory = await ensureProjectDirectory(projectId, title)
  await ensureDirectory(join(projectDirectory, PROJECT_SOURCES_DIRECTORY))
  await ensureDirectory(join(projectDirectory, PROJECT_STATE_DIRECTORY))
  await assertProjectRoot(projectDirectory, projectId, title)
  return {
    projectId,
    projectDirectory,
    network: "disabled",
    sandbox: "workspace-write",
  }
}

/** Returns an explicit policy for a research task, the sole network exception. */
export function researchAgentPolicy(
  policy: ProjectAgentPolicy,
  research: boolean
): ProjectAgentPolicy {
  if (policy.network === "research" && !research)
    throw new Error("Research network access must be explicitly requested")
  return research ? { ...policy, network: "research" } : policy
}

/** Explains why this host cannot safely launch writable project agents yet. */
export const PROJECT_AGENT_UNAVAILABLE =
  "Project agents are unavailable on this host. File isolation support is required before an agent can edit project files."

/** Refuses execution until a runtime can enforce protected reads and writes. */
export async function runProjectAgent(
  policy: ProjectAgentPolicy,
  request: string,
  options: {
    model?: string
    effort?: string
    executable?: string
    signal?: AbortSignal
    onText?: (text: string) => void
  } = {}
): Promise<ProjectAgentRunResult> {
  options.signal?.throwIfAborted()
  if (!request.trim()) throw new Error("Agent request is required")
  await assertProjectRoot(policy.projectDirectory, policy.projectId)
  throw new Error(PROJECT_AGENT_UNAVAILABLE)
}

/** Resolves a writable artifact key and rejects Sources, state, and escapes. */
export function resolveWritableArtifactPath(
  projectDirectory: string,
  fileKey: string
): string {
  const key = normalizeProjectFileKey(fileKey)
  const first = key.split("/")[0]
  if (
    first.toLowerCase() === PROJECT_SOURCES_DIRECTORY.toLowerCase() ||
    first.toLowerCase() === PROJECT_STATE_DIRECTORY
  )
    throw new Error("Project agent cannot write protected project data")
  const target = resolve(projectDirectory, ...key.split("/"))
  const outside = relative(resolve(projectDirectory), target)
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside))
    throw new Error("Artifact path escapes the project")
  return target
}

/** Scans writable project files and omits protected directories and temp files. */
export async function scanProjectArtifacts(
  projectDirectory: string
): Promise<ProjectArtifactSnapshot[]> {
  await assertProjectRoot(projectDirectory)
  const artifacts: ProjectArtifactSnapshot[] = []
  await walk(projectDirectory, "", artifacts)
  return artifacts.sort((a, b) => a.relativeKey.localeCompare(b.relativeKey))
}

/** Checks that the project root is the expected stable directory and has no symlink. */
async function assertProjectRoot(
  projectDirectory: string,
  projectId?: string,
  title?: string
): Promise<void> {
  const root = resolve(projectDirectory)
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Project agent requires a real project directory")
  if (projectId && root !== resolve(getProjectDirectory(projectId, title)))
    throw new Error("Project agent directory does not belong to this project")
}

/** Recursively scans one directory while rejecting symlinks and oversized files. */
async function walk(
  root: string,
  prefix: string,
  output: ProjectArtifactSnapshot[]
): Promise<void> {
  const entries = await fs.readdir(join(root, prefix), { withFileTypes: true })
  for (const entry of entries) {
    if (
      !prefix &&
      (entry.name.toLowerCase() === PROJECT_SOURCES_DIRECTORY.toLowerCase() ||
        entry.name.toLowerCase() === PROJECT_STATE_DIRECTORY)
    )
      continue
    if (entry.name.startsWith(".") && entry.name.endsWith(".uploading"))
      continue
    const key = prefix ? `${prefix}/${entry.name}` : entry.name
    const path = resolveWritableArtifactPath(root, key)
    const info = await fs.lstat(path)
    if (info.isSymbolicLink())
      throw new Error("Project artifacts may not use symlinks")
    if (info.isDirectory()) {
      output.push({ relativeKey: key, kind: "directory" })
      await walk(root, key, output)
      continue
    }
    if (!info.isFile()) continue
    if (info.size > MAX_AGENT_ARTIFACT_BYTES)
      throw new Error("Project artifact is too large")
    const hash = createHash("sha256")
    hash.update(await fs.readFile(path))
    output.push({
      relativeKey: key,
      kind: "file",
      sizeBytes: info.size,
      contentHash: hash.digest("hex"),
    })
  }
}

/** Creates a real directory without permitting an existing symlink. */
async function ensureDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Project protected directory is unsafe")
}
