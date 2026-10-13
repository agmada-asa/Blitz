/**
 * Declares what Blitz requires from each local provider runtime and checks an
 * installed runtime against those requirements.
 *
 * Provider CLIs update independently of Blitz. This module is the single
 * place that records the versions, Codex protocol methods, protocol enum
 * values, and model catalog Blitz was built against, so the provider
 * registry and `npm run check:runtimes` report drift from the same source
 * instead of failing later inside a chat turn.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { AiProviderId } from "../../ai-model-settings.ts"

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
 * Version gates for providers whose CLI flags or protocol changed in ways
 * Blitz depends on. Providers without an entry accept any version that runs.
 */
export const PROVIDER_VERSION_REQUIREMENTS: Readonly<
  Partial<Record<AiProviderId, ProviderVersionRequirement>>
> = {
  "claude-code": { minimum: "2.1.248", reason: "restricted turns" },
  opencode: {
    minimum: "1.18.21",
    sameMajor: true,
    reason: "native permissions",
  },
}

/** Result of comparing one CLI's `--version` output with its requirement. */
export type ProviderVersionCheck = {
  /** Whether Blitz can run turns through this version. */
  readonly supported: boolean
  /** Parsed `major.minor.patch`, when the output contained one. */
  readonly version?: string
}

/**
 * Reads the first `major.minor.patch` triple from CLI version output.
 *
 * @param output - Raw `--version` output, which may include a product name.
 * @returns The numeric triple, or undefined when no version is present.
 */
export function parseRuntimeVersion(
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
 * Checks one provider's `--version` output against its requirement.
 *
 * @param providerId - Provider whose requirement applies.
 * @param output - Raw `--version` output.
 * @returns Unsupported when a requirement exists and the output has no
 *   version, an older version, or a different major version where one is
 *   required; supported otherwise.
 */
export function checkProviderVersion(
  providerId: AiProviderId,
  output: string
): ProviderVersionCheck {
  const parsed = parseRuntimeVersion(output)
  const version = parsed?.join(".")
  const requirement = PROVIDER_VERSION_REQUIREMENTS[providerId]
  if (!requirement) return { supported: true, ...(version ? { version } : {}) }
  const minimum = parseRuntimeVersion(requirement.minimum)
  if (!parsed || !minimum) return { supported: false }
  const supported =
    compareVersions(parsed, minimum) >= 0 &&
    (!requirement.sameMajor || parsed[0] === minimum[0])
  return { supported, version: parsed.join(".") }
}

/**
 * Returns setup guidance naming the release a provider needs.
 *
 * @param providerId - Provider with a version requirement.
 * @returns Update guidance, or undefined when the provider has no gate.
 */
export function providerVersionGuidance(
  providerId: AiProviderId
): string | undefined {
  const requirement = PROVIDER_VERSION_REQUIREMENTS[providerId]
  if (!requirement) return undefined
  const name = providerId === "opencode" ? "OpenCode" : "Claude Code"
  const major = requirement.minimum.split(".")[0]
  return `Update ${name} to version ${requirement.minimum} or newer${
    requirement.sameMajor ? ` within v${major}` : ""
  } for ${requirement.reason}.`
}

/**
 * Codex app-server protocol surface Blitz calls or interprets.
 *
 * Every Codex method string in the codebase must appear here; a test scans
 * the source to enforce that. Enum entries list only the values Blitz
 * branches on, so new values added by Codex do not count as drift.
 */
export const CODEX_PROTOCOL_CONTRACT = {
  clientRequests: [
    "initialize",
    "thread/start",
    "thread/resume",
    "turn/start",
    "turn/interrupt",
    "model/list",
  ],
  clientNotifications: ["initialized"],
  serverNotifications: [
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/textDelta",
    "item/reasoning/summaryTextDelta",
    "turn/completed",
  ],
  serverRequests: [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "item/tool/call",
    "mcpServer/elicitation/request",
  ],
  enums: {
    ThreadItem: ["agentMessage", "reasoning"],
    MessagePhase: ["commentary"],
    TurnStatus: ["completed", "failed", "interrupted"],
    CodexErrorInfo: [
      "serverOverloaded",
      "usageLimitExceeded",
      "rateLimitExceeded",
    ],
  },
} as const

/** Method groups in the Codex protocol, keyed like {@link CODEX_PROTOCOL_CONTRACT}. */
export type CodexProtocolMethodGroup = Exclude<
  keyof typeof CODEX_PROTOCOL_CONTRACT,
  "enums"
>

/** Schema files `codex app-server generate-json-schema` writes for each group. */
const CODEX_SCHEMA_FILES: Readonly<Record<CodexProtocolMethodGroup, string>> = {
  clientRequests: "ClientRequest.json",
  clientNotifications: "ClientNotification.json",
  serverNotifications: "ServerNotification.json",
  serverRequests: "ServerRequest.json",
}

/** Methods and shared definitions read from one generated protocol schema. */
export type CodexProtocolSurface = {
  readonly methods: Readonly<
    Record<CodexProtocolMethodGroup, ReadonlySet<string>>
  >
  readonly definitions: Readonly<Record<string, unknown>>
}

/** Reads an object-like JSON value without trusting its shape. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Collects method names from the `oneOf` variants of one message schema. */
function schemaMethods(schema: unknown): Set<string> {
  const methods = new Set<string>()
  const variants = asObject(schema)?.oneOf
  if (!Array.isArray(variants)) return methods
  for (const variant of variants) {
    const method = asObject(asObject(asObject(variant)?.properties)?.method)
    const values = Array.isArray(method?.enum) ? method.enum : []
    for (const value of values)
      if (typeof value === "string") methods.add(value)
  }
  return methods
}

/**
 * Reads the protocol surface from a generated schema directory.
 *
 * @param schemaDirectory - Output of `codex app-server generate-json-schema`.
 * @returns Methods per group and the merged shared definitions.
 * @throws When a schema file is missing or is not valid JSON.
 */
export async function readCodexProtocolSurface(
  schemaDirectory: string
): Promise<CodexProtocolSurface> {
  const methods = {} as Record<CodexProtocolMethodGroup, ReadonlySet<string>>
  const definitions: Record<string, unknown> = {}
  for (const [group, file] of Object.entries(CODEX_SCHEMA_FILES) as [
    CodexProtocolMethodGroup,
    string,
  ][]) {
    const schema: unknown = JSON.parse(
      await readFile(join(schemaDirectory, file), "utf8")
    )
    methods[group] = schemaMethods(schema)
    Object.assign(definitions, asObject(asObject(schema)?.definitions) ?? {})
  }
  return { methods, definitions }
}

/** Collects every string `enum` or `const` value nested inside a definition. */
function enumValues(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) enumValues(item, output)
    return output
  }
  const object = asObject(value)
  if (!object) return output
  if (Array.isArray(object.enum))
    for (const item of object.enum)
      if (typeof item === "string") output.add(item)
  if (typeof object.const === "string") output.add(object.const)
  for (const child of Object.values(object)) enumValues(child, output)
  return output
}

/** Readable labels for method groups in drift reports. */
const METHOD_GROUP_LABELS: Readonly<Record<CodexProtocolMethodGroup, string>> =
  {
    clientRequests: "client request",
    clientNotifications: "client notification",
    serverNotifications: "server notification",
    serverRequests: "server request",
  }

/**
 * Lists contract entries the installed Codex protocol no longer provides.
 *
 * @param surface - Protocol read by {@link readCodexProtocolSurface}.
 * @returns One readable problem per missing method or enum value; empty when
 *   the runtime still provides everything Blitz uses.
 */
export function codexProtocolProblems(surface: CodexProtocolSurface): string[] {
  const problems: string[] = []
  for (const group of Object.keys(
    METHOD_GROUP_LABELS
  ) as CodexProtocolMethodGroup[]) {
    for (const method of CODEX_PROTOCOL_CONTRACT[group])
      if (!surface.methods[group].has(method))
        problems.push(`Missing ${METHOD_GROUP_LABELS[group]}: ${method}`)
  }
  for (const [name, required] of Object.entries(
    CODEX_PROTOCOL_CONTRACT.enums
  )) {
    const definition = surface.definitions[name]
    if (definition === undefined) {
      problems.push(`Missing protocol definition: ${name}`)
      continue
    }
    const values = enumValues(definition)
    for (const value of required)
      if (!values.has(value))
        problems.push(`${name} no longer includes ${value}`)
  }
  return problems
}

/** Minimal model shape compared between Blitz's fallback list and a runtime. */
export type ComparableModel = {
  readonly id: string
  readonly reasoningEfforts?: readonly string[]
}

/** Differences between Blitz's fallback model list and a live catalog. */
export type ModelCatalogDrift = {
  /** Live models missing from the fallback list. */
  readonly added: readonly string[]
  /** Fallback models the runtime no longer serves. */
  readonly removed: readonly string[]
  /** Models whose reasoning levels differ, with both lists for the report. */
  readonly changed: readonly {
    readonly id: string
    readonly fallback: readonly string[]
    readonly live: readonly string[]
  }[]
}

/**
 * Compares the fallback model list with a runtime catalog by ID and
 * reasoning levels. Labels are ignored because runtimes and Blitz format
 * them differently.
 *
 * @param fallback - Blitz's built-in model list.
 * @param live - Models the installed runtime reports.
 * @returns Added, removed, and changed models; all empty when in sync.
 */
export function diffModelCatalog(
  fallback: readonly ComparableModel[],
  live: readonly ComparableModel[]
): ModelCatalogDrift {
  const fallbackById = new Map(fallback.map((model) => [model.id, model]))
  const liveIds = new Set(live.map((model) => model.id))
  const changed: ModelCatalogDrift["changed"][number][] = []
  for (const model of live) {
    const known = fallbackById.get(model.id)
    if (!known) continue
    const fallbackEfforts = known.reasoningEfforts ?? []
    const liveEfforts = model.reasoningEfforts ?? []
    if (fallbackEfforts.join() !== liveEfforts.join())
      changed.push({
        id: model.id,
        fallback: fallbackEfforts,
        live: liveEfforts,
      })
  }
  return {
    added: live
      .filter((model) => !fallbackById.has(model.id))
      .map((model) => model.id),
    removed: fallback
      .filter((model) => !liveIds.has(model.id))
      .map((model) => model.id),
    changed,
  }
}

/** Returns whether a catalog comparison found any drift. */
export function hasModelCatalogDrift(drift: ModelCatalogDrift): boolean {
  return (
    drift.added.length > 0 ||
    drift.removed.length > 0 ||
    drift.changed.length > 0
  )
}
