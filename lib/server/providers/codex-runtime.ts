/**
 * Tells Codex turns where the locally installed Codex dependency bundle lives.
 *
 * The Codex desktop app installs a bundle with its own Python (pypdf,
 * pdfplumber, pypdfium2), Node.js packages, and native tools such as Poppler.
 * Its skills, including the PDF skill, expect those tools, and the desktop
 * app tells the model where they are through a "Workspace Dependencies"
 * instruction block instead of changing PATH. Codex turns started by Blitz
 * never received that block, so the model fell back to the system Python
 * and could not read attached PDFs. This module rebuilds the same block from
 * the bundle's own metadata so Blitz turns get the same tools.
 */

import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** Bundle metadata fields this module relies on, from `runtime.json`. */
type CodexRuntimeMetadata = {
  bundleVersion?: string
  pythonVersion?: string
}

/** Resolved, verified locations inside one installed dependency bundle. */
export type CodexRuntimePaths = {
  bundleVersion?: string
  nodePath: string
  nodeModulesPath: string
  pythonPath: string
  pythonLibrariesPath: string
  overrideBinPath: string
  fallbackBinPath: string
  gitPath?: string
}

/** How long a lookup result is reused; the bundle changes only on app updates. */
const CACHE_TTL_MS = 5 * 60_000

let cached: { at: number; root: string; paths: CodexRuntimePaths | null } | undefined

/**
 * Returns the bundle root, honoring `BLITZ_CODEX_RUNTIME_DIR` for unusual installs.
 *
 * @returns The absolute directory expected to contain `runtime.json`.
 */
export function codexRuntimeRoot(): string {
  return (
    process.env.BLITZ_CODEX_RUNTIME_DIR?.trim() ||
    join(homedir(), ".cache", "codex-runtimes", "codex-primary-runtime")
  )
}

/** Returns whether a path exists and matches the expected entry type. */
async function exists(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const info = await stat(path)
    return kind === "file" ? info.isFile() : info.isDirectory()
  } catch {
    return false
  }
}

/**
 * Finds and verifies the installed Codex dependency bundle.
 *
 * @param root - Bundle directory; defaults to {@link codexRuntimeRoot}.
 * @returns Verified tool paths, or null when the bundle is missing, has
 *   unreadable metadata, or lacks its Python or Node.js runtime.
 */
export async function findCodexRuntime(
  root = codexRuntimeRoot()
): Promise<CodexRuntimePaths | null> {
  if (cached && cached.root === root && Date.now() - cached.at < CACHE_TTL_MS)
    return cached.paths
  let paths: CodexRuntimePaths | null = null
  try {
    const metadata = JSON.parse(
      await readFile(join(root, "runtime.json"), "utf8")
    ) as CodexRuntimeMetadata
    const dependencies = join(root, "dependencies")
    // Packages live under the minor version, for example python3.12.
    const pythonMinor = /^(\d+\.\d+)/.exec(metadata.pythonVersion ?? "")?.[1]
    const candidate: CodexRuntimePaths = {
      ...(metadata.bundleVersion ? { bundleVersion: metadata.bundleVersion } : {}),
      nodePath: join(dependencies, "node", "bin", "node"),
      nodeModulesPath: join(dependencies, "node", "node_modules"),
      pythonPath: join(dependencies, "python", "bin", "python3"),
      pythonLibrariesPath: join(
        dependencies,
        "python",
        "lib",
        `python${pythonMinor ?? "3"}`,
        "site-packages"
      ),
      overrideBinPath: join(dependencies, "bin", "override"),
      fallbackBinPath: join(dependencies, "bin", "fallback"),
    }
    const gitPath = join(candidate.fallbackBinPath, "git")
    const [python, packages, node, modules, git] = await Promise.all([
      exists(candidate.pythonPath, "file"),
      exists(candidate.pythonLibrariesPath, "directory"),
      exists(candidate.nodePath, "file"),
      exists(candidate.nodeModulesPath, "directory"),
      exists(gitPath, "file"),
    ])
    if (python && packages && node && modules)
      paths = { ...candidate, ...(git ? { gitPath } : {}) }
  } catch {
    paths = null
  }
  cached = { at: Date.now(), root, paths }
  return paths
}

/**
 * Formats the dependency block the Codex desktop app attaches to its turns.
 *
 * @param paths - Verified bundle locations.
 * @returns Developer instructions listing each bundled tool location.
 */
export function codexRuntimeInstructions(paths: CodexRuntimePaths): string {
  return [
    "### Workspace Dependencies",
    "Use these bundled paths for sheets, slides, documents, PDFs, images, or browser automation:",
    ...(paths.bundleVersion ? [`- Bundle version: ${paths.bundleVersion}`] : []),
    ...(paths.gitPath ? [`- Git executable: ${paths.gitPath}`] : []),
    `- Node.js executable: ${paths.nodePath}`,
    `- Node.js packages: ${paths.nodeModulesPath}`,
    `- Python executable: ${paths.pythonPath}`,
    `- Python packages: ${paths.pythonLibrariesPath}`,
    `- Override binaries: ${paths.overrideBinPath}`,
    `- Fallback binaries: ${paths.fallbackBinPath}`,
  ].join("\n")
}

/**
 * Returns the dependency block for the installed bundle, if there is one.
 *
 * @returns Developer instructions, or undefined when no usable bundle exists.
 */
export async function codexRuntimeInstructionsIfInstalled(): Promise<
  string | undefined
> {
  const paths = await findCodexRuntime()
  return paths ? codexRuntimeInstructions(paths) : undefined
}
