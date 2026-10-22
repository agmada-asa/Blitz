/**
 * Declares the OpenCode release Blitz requires and checks an installed CLI
 * against it.
 *
 * Codex and Claude Code compatibility belongs to agent-engines: it pins the
 * Codex protocol it was generated from, refuses older runtimes when a thread
 * starts, and its own `check:runtimes` watches both CLIs weekly. OpenCode runs
 * on Blitz's ACP adapter, so Blitz keeps its gate here, and the provider
 * registry and `npm run check:runtimes` read the same requirement. It imports
 * nothing, so the weekly workflow can run it without installing the app.
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

/** OpenCode's requirement: the ACP permission flow Blitz's approvals depend on. */
export const OPENCODE_VERSION_REQUIREMENT: ProviderVersionRequirement = {
  minimum: "1.18.21",
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
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
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
 * Checks OpenCode's `--version` output against its requirement.
 *
 * @param output - Raw `--version` output.
 * @returns Unsupported when the output has no version, an older one, or a
 *   different major version; supported otherwise.
 */
export function checkOpenCodeVersion(output: string): ProviderVersionCheck {
  const parsed = parseRuntimeVersion(output)
  const minimum = parseRuntimeVersion(OPENCODE_VERSION_REQUIREMENT.minimum)
  if (!parsed || !minimum) return { supported: false }
  const supported =
    compareVersions(parsed, minimum) >= 0 &&
    (!OPENCODE_VERSION_REQUIREMENT.sameMajor || parsed[0] === minimum[0])
  return { supported, version: parsed.join(".") }
}

/** Setup guidance naming the OpenCode release Blitz needs. */
export function openCodeVersionGuidance(): string {
  const { minimum, sameMajor, reason } = OPENCODE_VERSION_REQUIREMENT
  return `Update OpenCode to version ${minimum} or newer${
    sameMajor ? ` within v${minimum.split(".")[0]}` : ""
  } for ${reason}.`
}
