/** Validates source-backed links between project learning concepts. */

import { z } from "zod"

/** Relationships the learning path can explain without relying on a vague similarity score. */
export const CONCEPT_RELATION_KINDS = [
  "prerequisite_for",
  "part_of",
  "causes",
  "contrasts_with",
  "applies_to",
  "related_to",
] as const

/** A saved relationship's direction and meaning. */
export type ConceptRelationKind = (typeof CONCEPT_RELATION_KINDS)[number]

/** One existing concept or lesson page written by the current source job. */
const conceptEndpointSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("concept"), id: z.string().min(1).max(128) })
    .strict(),
  z
    .object({
      kind: z.literal("page"),
      key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    })
    .strict(),
])

/** One exact section or useful original-file location supporting a link. */
const conceptEvidenceSchema = z
  .object({
    sectionId: z.string().min(1).max(180).optional(),
    locator: z.string().trim().min(1).max(180),
  })
  .strict()

/** Bounded agent draft for a relationship learned from the current source. */
export const conceptConnectionSchema = z
  .object({
    from: conceptEndpointSchema,
    to: conceptEndpointSchema,
    kind: z.enum(CONCEPT_RELATION_KINDS),
    explanation: z.string().trim().min(1).max(300),
    evidence: z.array(conceptEvidenceSchema).min(1).max(4),
  })
  .strict()

/** A validated relationship before page keys are resolved to saved concept IDs. */
export type ConceptConnection = z.infer<typeof conceptConnectionSchema>

/** Maximum relationships one source job may add or replace. */
export const MAX_CONCEPT_CONNECTIONS = 80

/** Returns a stable identity for either endpoint in a relationship draft. */
function endpointKey(endpoint: ConceptConnection["from"]): string {
  return endpoint.kind === "page"
    ? `page:${endpoint.key}`
    : `concept:${endpoint.id}`
}

/** Validates draft endpoints, distinct links, and evidence against this source's included sections. */
export function validateConceptConnections(
  value: unknown,
  options: {
    pageKeys: ReadonlySet<string>
    knownConceptIds: ReadonlySet<string>
    includedSectionIds: ReadonlySet<string>
    extractedSectionIds: ReadonlySet<string>
  }
): ConceptConnection[] {
  const connections = z
    .array(conceptConnectionSchema)
    .max(MAX_CONCEPT_CONNECTIONS)
    .parse(value)
  const seen = new Set<string>()
  for (const connection of connections) {
    for (const endpoint of [connection.from, connection.to]) {
      if (endpoint.kind === "page" && !options.pageKeys.has(endpoint.key))
        throw new Error(
          "Concept relationship references an unknown lesson page"
        )
      if (
        endpoint.kind === "concept" &&
        !options.knownConceptIds.has(endpoint.id)
      )
        throw new Error("Concept relationship references an unknown concept")
    }
    const from = endpointKey(connection.from)
    const to = endpointKey(connection.to)
    if (from === to) throw new Error("A concept cannot link to itself")
    const pair =
      connection.kind === "contrasts_with" || connection.kind === "related_to"
        ? [from, to].sort()
        : [from, to]
    const key = `${connection.kind}\0${pair.join("\0")}`
    if (seen.has(key)) throw new Error("Concept draft repeats a relationship")
    seen.add(key)
    for (const evidence of connection.evidence) {
      if (options.extractedSectionIds.size && !evidence.sectionId)
        throw new Error(
          "Concept relationship needs an extracted source section"
        )
      if (
        evidence.sectionId &&
        !options.includedSectionIds.has(evidence.sectionId)
      )
        throw new Error(
          "Concept relationship cites a missing or skipped section"
        )
    }
  }
  return connections
}
