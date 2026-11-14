/**
 * Declares the OpenCode and Antigravity releases Blitz requires and checks an
 * installed CLI against them.
 *
 * Codex and Claude Code compatibility belongs to agent-engines: it pins the
 * Codex protocol it was generated from, refuses older runtimes when a thread
 * starts, and its own `check:runtimes` watches both CLIs weekly. OpenCode and
 * Antigravity run on the library's generic ACP engine, which has no floor for
 * either, so Blitz keeps their gates here, and the provider registry and
 * `npm run check:runtimes` read the same requirements. It imports nothing, so
 * the weekly workflow can run it without installing the app.
 */

/** Oldest supported release of one provider CLI. */
export type ProviderVersionRequirement = {
  /** Oldest `major.minor.patch` release with the features Blitz relies on. */
  readonly minimum: string
  /** Rejects other major versions when their protocol is not yet reviewed. */
  readonly sameMajor?: boolean
  /** Feature that sets the minimum, used in setup guidance. */
  readonly reason: string
}

/**
 * OpenCode's requirement: the v2 ACP server and the per-agent permissions in
 * `OPENCODE_CONFIG_CONTENT` that Blitz's approvals depend on. v2 dropped the
 * `--pure` flag and the `OPENCODE_PERMISSION` variable v1 turns used, so v1
 * is no longer supported. 2.3.0 is the release Blitz was checked against.
 */
export const OPENCODE_VERSION_REQUIREMENT: ProviderVersionRequirement = {
  minimum: "2.3.0",
  sameMajor: true,
  reason: "native permissions",
}

/** Result of comparing one CLI's `--version` output with its requirement. */
export type ProviderVersionCheck = {
  /** Whether Blitz can run turns through this version. */
  readonly supported: boolean
  /** Parsed `major.minor.patch`, when the output contained one. */
  readonly version?: string
}

/** Reads the first `major.minor.patch` triple from CLI version output. */
function parseRuntimeVersion(
  output: string
): readonly [number, number, number] | undefined {
  // OpenCode v2 prints `opencode v2.3.0`, so a `v` may lead the number.
  const match = output.match(/(?<![\w.])v?(\d+)\.(\d+)\.(\d+)\b/)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Orders two version triples, returning a negative, zero, or positive number. */
function compareVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
}

/**
 * Antigravity's requirement: CLI 1.5 is the first with its own `agy acp`
 * server. Any later major is accepted, since Blitz uses only standard ACP and
 * the `--sandbox` flag.
 */
export const ANTIGRAVITY_VERSION_REQUIREMENT: ProviderVersionRequirement = {
  minimum: "1.5.0",
  reason: "its built-in ACP server",
}

/**
 * Checks a CLI's `--version` output against one requirement.
 *
 * @param output - Raw `--version` output.
 * @param requirement - The release the CLI must be.
 * @returns Unsupported when the output has no version, an older one, or a
 *   different major version where only one is reviewed; supported otherwise.
 */
export function checkRuntimeVersion(
  output: string,
  requirement: ProviderVersionRequirement
): ProviderVersionCheck {
  const parsed = parseRuntimeVersion(output)
  const minimum = parseRuntimeVersion(requirement.minimum)
  if (!parsed || !minimum) return { supported: false }
  const supported =
    compareVersions(parsed, minimum) >= 0 &&
    (!requirement.sameMajor || parsed[0] === minimum[0])
  return { supported, version: parsed.join(".") }
}

/** Checks OpenCode's `--version` output against its requirement. */
export function checkOpenCodeVersion(output: string): ProviderVersionCheck {
  return checkRuntimeVersion(output, OPENCODE_VERSION_REQUIREMENT)
}

/** Checks Antigravity's `--version` output against its requirement. */
export function checkAntigravityVersion(output: string): ProviderVersionCheck {
  return checkRuntimeVersion(output, ANTIGRAVITY_VERSION_REQUIREMENT)
}

/** Setup guidance naming the release of one CLI that Blitz needs. */
function versionGuidance(
  name: string,
  requirement: ProviderVersionRequirement
): string {
  const { minimum, sameMajor, reason } = requirement
  return `Update ${name} to version ${minimum} or newer${
    sameMajor ? ` within v${minimum.split(".")[0]}` : ""
  } for ${reason}.`
}

/** Setup guidance naming the OpenCode release Blitz needs. */
export function openCodeVersionGuidance(): string {
  return versionGuidance("OpenCode", OPENCODE_VERSION_REQUIREMENT)
}

/** Setup guidance naming the Antigravity release Blitz needs. */
export function antigravityVersionGuidance(): string {
  return versionGuidance("Antigravity", ANTIGRAVITY_VERSION_REQUIREMENT)
}
