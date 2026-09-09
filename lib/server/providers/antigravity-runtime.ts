/** Discovers shared Antigravity ACP binaries and installs a Blitz-managed copy. */

import { existsSync, readdirSync, statSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

const ACP_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_EXECUTABLE_BYTES = 1536 * 1024 * 1024
const MAX_INSTALL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_DISCOVERY_ENTRIES = 20_000
const EXECUTABLE_NAME =
  process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par"
const COMPANION_NAME =
  process.platform === "win32"
    ? "localharness_external.exe"
    : "localharness_external"

/** Returns whether a discovered runtime includes the helper required by Google. */
function isCompleteRuntime(path: string): boolean {
  return (
    existsSync(path) &&
    statSync(path).isFile() &&
    existsSync(join(dirname(path), COMPANION_NAME))
  )
}

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
      if (
        entry.isFile() &&
        entry.name === EXECUTABLE_NAME &&
        isCompleteRuntime(path)
      )
        return path
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
      .find((path) => path && isCompleteRuntime(path))
  } catch {
    return undefined
  }
}

/** Resolves an explicit, shared, or Blitz-managed Antigravity ACP executable. */
export function discoverAntigravityExecutable(): string | undefined {
  const explicit = process.env.BLITZ_ANTIGRAVITY_ACP_COMMAND?.trim()
  if (explicit) return explicit
  for (const root of sharedRuntimeRoots()) {
    const runtime = findRuntime(root)
    if (runtime) return runtime
  }
  return findIndexedMacRuntime()
}

type RegistryBinary = { archive: string; cmd: string }

/** Streams a response to disk while enforcing the archive limit on received bytes. */
async function downloadArchive(
  response: Response,
  destination: string
): Promise<void> {
  if (!response.body) throw new Error("The Antigravity ACP download was empty.")
  const file = await open(destination, "wx", 0o600)
  const reader = response.body.getReader()
  let received = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += chunk.value.byteLength
      if (received > MAX_ARCHIVE_BYTES) {
        await reader.cancel()
        throw new Error(
          "The Antigravity ACP download was larger than expected."
        )
      }
      await file.writeFile(chunk.value)
    }
  } finally {
    await file.close()
  }
  if (received === 0) throw new Error("The Antigravity ACP download was empty.")
}

/** Extracts the bounded official package without loading the archive into memory. */
async function extractArchive(
  archive: string,
  destination: string
): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error(
      "Automatic Antigravity ACP installation is unavailable on this computer."
    )
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(
      process.platform === "darwin" ? "/usr/bin/unzip" : "unzip",
      ["-q", archive, "-d", destination],
      { stdio: "ignore" }
    )
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.on("error", () =>
      finish(new Error("The Antigravity ACP package could not be extracted."))
    )
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error("The Antigravity ACP package could not be extracted.")
      )
    )
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(new Error("The Antigravity ACP package took too long to extract."))
    }, 120_000)
  })
}

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
  const archiveEntry = selected.binary.cmd.replace(/^\.\//, "")
  if (basename(archiveEntry) !== EXECUTABLE_NAME || archiveEntry.includes(".."))
    throw new Error("The ACP registry returned an invalid executable path.")
  const response = await fetch(selected.binary.archive, { cache: "no-store" })
  if (!response.ok) throw new Error("Could not download Antigravity ACP.")
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_ARCHIVE_BYTES)
    throw new Error("The Antigravity ACP download was larger than expected.")

  const root = antigravityInstallRoot()
  const destination = join(root, selected.version)
  const executable = join(destination, EXECUTABLE_NAME)
  const companion = join(destination, COMPANION_NAME)
  if (existsSync(executable) && existsSync(companion)) return executable
  await mkdir(root, { recursive: true })
  await rm(destination, { recursive: true, force: true })
  const temporary = await mkdtemp(join(root, ".install-"))
  try {
    const archive = join(temporary, "download.zip")
    const extracted = join(temporary, "extracted")
    const release = join(temporary, "release")
    await mkdir(extracted)
    await mkdir(release)
    await downloadArchive(response, archive)
    await extractArchive(archive, extracted)
    const extractedExecutable = join(extracted, archiveEntry)
    const executableInfo = await stat(extractedExecutable)
    if (
      !executableInfo.isFile() ||
      executableInfo.size === 0 ||
      executableInfo.size > MAX_EXECUTABLE_BYTES
    )
      throw new Error(
        "The Antigravity ACP package did not contain a valid executable."
      )
    const extractedCompanion = join(
      dirname(extractedExecutable),
      COMPANION_NAME
    )
    if (!existsSync(extractedCompanion))
      throw new Error(
        "The Antigravity ACP package did not contain its required helper."
      )
    const files = await readdir(dirname(extractedExecutable), {
      withFileTypes: true,
    })
    let installedBytes = 0
    for (const file of files) {
      if (!file.isFile()) continue
      const source = join(dirname(extractedExecutable), file.name)
      const info = await stat(source)
      installedBytes += info.size
      if (installedBytes > MAX_INSTALL_BYTES)
        throw new Error("The Antigravity ACP package was larger than expected.")
      const target = join(release, file.name)
      await copyFile(source, target)
      await chmod(target, 0o700)
    }
    await rename(release, destination)
    return executable
  } catch (error) {
    if (existsSync(executable) && existsSync(companion)) return executable
    throw error
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
