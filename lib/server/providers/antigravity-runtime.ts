/** Discovers shared Antigravity ACP binaries and installs a Blitz-managed copy. */

import { existsSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { unzipSync } from "fflate"

const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const MAX_DISCOVERY_ENTRIES = 20_000
const EXECUTABLE_NAME =
  process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"

/** Returns the OS-specific directory reserved for Blitz-managed provider runtimes. */
export function antigravityInstallRoot(): string {
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Blitz",
      "providers",
      "antigravity"
    )
  if (process.platform === "win32")
    return join(
      process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local"),
      "Blitz",
      "providers",
      "antigravity"
    )
  return join(
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
    "blitz",
    "providers",
    "antigravity"
  )
}

/** Lists likely local registries used by ACP clients without scanning the whole home directory. */
function sharedRuntimeRoots(): readonly string[] {
  const home = homedir()
  return [
    antigravityInstallRoot(),
    join(home, ".local", "share", "acp"),
    join(home, ".cache", "acp"),
    join(home, ".config", "zed"),
    join(home, "Library", "Application Support", "Zed"),
    join(home, "Library", "Caches", "Zed"),
    join(home, "Library", "Application Support", "JetBrains"),
    join(home, "Library", "Caches", "JetBrains"),
  ]
}

/** Finds an exact executable below one trusted app-data root with bounded traversal. */
function findRuntime(root: string, maxDepth = 7): string | undefined {
  if (!existsSync(root)) return undefined
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ]
  let inspected = 0
  while (pending.length > 0 && inspected < MAX_DISCOVERY_ENTRIES) {
    const current = pending.shift()!
    let entries
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      inspected += 1
      if (inspected >= MAX_DISCOVERY_ENTRIES) break
      const path = join(current.path, entry.name)
      if (entry.isFile() && entry.name === EXECUTABLE_NAME) return path
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        current.depth < maxDepth
      )
        pending.push({ path, depth: current.depth + 1 })
    }
  }
  return undefined
}

/** Uses the macOS metadata index to find copies managed by ACP clients outside known roots. */
function findIndexedMacRuntime(): string | undefined {
  if (process.platform !== "darwin") return undefined
  try {
    const output = execFileSync(
      "/usr/bin/mdfind",
      [`kMDItemFSName == "${EXECUTABLE_NAME}"c`],
      { encoding: "utf8", timeout: 2_000, maxBuffer: 32_000 }
    )
    return output
      .split("\n")
      .map((path) => path.trim())
      .find((path) => path && existsSync(path) && statSync(path).isFile())
  } catch {
    return undefined
  }
}

/** Resolves an explicit, shared, or Blitz-managed Antigravity ACP executable. */
export function discoverAntigravityExecutable(): string | undefined {
  const explicit = process.env.BLITZ_ANTIGRAVITY_ACP_COMMAND?.trim()
  if (explicit && existsSync(explicit) && statSync(explicit).isFile())
    return explicit
  for (const root of sharedRuntimeRoots()) {
    const runtime = findRuntime(root)
    if (runtime) return runtime
  }
  return findIndexedMacRuntime()
}

type RegistryBinary = { archive: string; cmd: string }

/** Selects the current machine's Antigravity package from the official ACP registry response. */
function registryBinary(value: unknown): {
  version: string
  binary: RegistryBinary
} {
  if (typeof value !== "object" || value === null)
    throw new Error("The ACP registry response was invalid.")
  const agents = (value as { agents?: unknown }).agents
  if (!Array.isArray(agents))
    throw new Error("The ACP registry response was invalid.")
  const agent = agents.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === "antigravity-acp"
  ) as
    | {
        version?: unknown
        distribution?: { binary?: Record<string, RegistryBinary> }
      }
    | undefined
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : ""
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64"
  const binary = agent?.distribution?.binary?.[`${platform}-${architecture}`]
  if (
    typeof agent?.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(agent.version) ||
    !binary ||
    typeof binary.archive !== "string" ||
    typeof binary.cmd !== "string"
  )
    throw new Error("Antigravity ACP is not available for this computer.")
  const archiveUrl = new URL(binary.archive)
  if (
    archiveUrl.protocol !== "https:" ||
    archiveUrl.hostname !== "dl.google.com"
  )
    throw new Error("The ACP registry returned an untrusted download location.")
  return { version: agent.version, binary }
}

/** Downloads the official registry package and atomically installs its ACP executable. */
export async function installAntigravityRuntime(): Promise<string> {
  const registryResponse = await fetch(ACP_REGISTRY_URL, { cache: "no-store" })
  if (!registryResponse.ok) throw new Error("Could not load the ACP registry.")
  const selected = registryBinary(await registryResponse.json())
  const response = await fetch(selected.binary.archive, { cache: "no-store" })
  if (!response.ok) throw new Error("Could not download Antigravity ACP.")
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_ARCHIVE_BYTES)
    throw new Error("The Antigravity ACP download was larger than expected.")
  const archive = new Uint8Array(await response.arrayBuffer())
  if (archive.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error("The Antigravity ACP download was larger than expected.")
  const files = unzipSync(archive)
  const entry = Object.entries(files).find(
    ([name]) => basename(name.replaceAll("\\", "/")) === EXECUTABLE_NAME
  )
  if (
    !entry ||
    entry[1].byteLength === 0 ||
    entry[1].byteLength > MAX_ARCHIVE_BYTES
  )
    throw new Error(
      "The Antigravity ACP package did not contain its executable."
    )

  const root = antigravityInstallRoot()
  const destination = join(root, selected.version)
  const executable = join(destination, EXECUTABLE_NAME)
  if (existsSync(executable)) return executable
  await mkdir(root, { recursive: true })
  const temporary = await mkdtemp(join(root, ".install-"))
  try {
    const temporaryExecutable = join(temporary, EXECUTABLE_NAME)
    await writeFile(temporaryExecutable, entry[1], { mode: 0o700 })
    await chmod(temporaryExecutable, 0o700)
    await rename(temporary, destination)
    return executable
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    if (existsSync(executable)) return executable
    throw error
  }
}
