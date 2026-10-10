/** Provides bounded exact retrieval over persisted source chunks and citations. */

import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  assembleRetrievedContext,
  rankExactCandidates,
  MAX_RETRIEVAL_CONTEXT_CHARS,
  MAX_RETRIEVAL_RESULTS,
} from "../lib/source-retrieval"

const MAX_QUERY_LENGTH = 500
const MAX_RESULTS = MAX_RETRIEVAL_RESULTS
const MAX_NEIGHBORS = 5
const MAX_CONTEXT_CHARS = MAX_RETRIEVAL_CONTEXT_CHARS
const MAX_CHUNK_TEXT = 12_000
/** Per-query cache of each source's live filename, or null when the source is gone. */
type SourceNameCache = Map<string, string | null>
const STOP_WORDS = new Set([
  "about",
  "after",
  "does",
  "from",
  "have",
  "into",
  "more",
  "that",
  "their",
  "these",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
])

const reference = v.object({
  kind: v.optional(
    v.union(v.literal("page"), v.literal("slide"), v.literal("time"))
  ),
  label: v.string(),
  value: v.string(),
  startOffset: v.number(),
  endOffset: v.number(),
})

/** Public citation shape returned with retrieved text. */
export type RetrievalCitation = {
  sourceId: Id<"sources">
  sourceFilename: string
  chunkId: Id<"sourceChunks">
  ordinal: number
  references: Doc<"sourceChunks">["references"]
}

/** Public text result used by chat and generation callers. */
export type RetrievalResult = {
  text: string
  citation: RetrievalCitation
}

/** Filters bounded chunk candidates by an exact case-insensitive phrase. */

/** Finds bounded exact matches for internal composition by retrieval queries. */
async function exactSearchFor(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  value: string,
  maxResultsInput?: number,
  sourceNameCache: SourceNameCache = new Map()
): Promise<RetrievalResult[]> {
  const needle = boundedQuery(value).toLocaleLowerCase()
  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.floor(maxResultsInput ?? 8))
  )
  const chunks = await ctx.db
    .query("sourceChunks")
    .withSearchIndex("search_text", (q) =>
      q.search("text", value).eq("projectId", projectId)
    )
    .take(MAX_RESULTS * 4)
  const matches: RetrievalResult[] = []
  for (const chunk of rankExactCandidates(chunks, needle, maxResults)) {
    const result = await resultForChunk(ctx, chunk, sourceNameCache)
    if (result) matches.push(result)
    if (matches.length >= maxResults) break
  }
  return matches
}

/** Reads a bounded neighborhood for internal context assembly. */
async function neighborsFor(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  sourceId: Id<"sources">,
  ordinal: number,
  radiusInput?: number,
  sourceNameCache: SourceNameCache = new Map()
): Promise<RetrievalResult[]> {
  const radius = Math.min(
    MAX_NEIGHBORS,
    Math.max(0, Math.floor(radiusInput ?? 2))
  )
  const chunks = await ctx.db
    .query("sourceChunks")
    .withIndex("by_project_source_ordinal", (q) =>
      q
        .eq("projectId", projectId)
        .eq("sourceId", sourceId)
        .gte("ordinal", Math.max(0, ordinal - radius))
        .lte("ordinal", ordinal + radius)
    )
    .order("asc")
    .take(radius * 2 + 1)
  const results = await Promise.all(
    chunks.map((chunk) => resultForChunk(ctx, chunk, sourceNameCache))
  )
  return results.filter((result): result is RetrievalResult => result !== null)
}

/** Retrieves cited context for a natural-language question using bounded keyword candidates. */
export async function retrieveProjectContext(
  ctx: Pick<QueryCtx, "db">,
  projectId: Id<"projects">,
  question: string,
  options: {
    maxResults?: number
    neighborRadius?: number
    maxChars?: number
  } = {}
): Promise<{ results: RetrievalResult[]; characterCount: number }> {
  const trimmed = question.trim()
  if (!trimmed) return { results: [], characterCount: 0 }
  const words = boundedQuery(trimmed)
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)
    .filter((word) => !STOP_WORDS.has(word))
    .filter((word, index, all) => all.indexOf(word) === index)
    .slice(0, 8)
  const matches: RetrievalResult[] = []
  const sourceNameCache: SourceNameCache = new Map()
  for (const word of words) {
    const found = await exactSearchFor(
      ctx,
      projectId,
      word,
      options.maxResults ?? 6,
      sourceNameCache
    )
    for (const result of found) {
      if (
        !matches.some(
          (item) => item.citation.chunkId === result.citation.chunkId
        )
      )
        matches.push(result)
    }
  }
  const maxChars = Math.min(
    MAX_CONTEXT_CHARS,
    Math.max(500, Math.floor(options.maxChars ?? 8_000))
  )
  // Rank passages matching several query terms first. Keep anchor passages
  // ahead of their neighbors so surrounding text cannot consume their budget.
  matches.sort((a, b) => {
    const score = (result: RetrievalResult) =>
      words.filter((word) => result.text.toLocaleLowerCase().includes(word))
        .length
    return score(b) - score(a) || a.citation.ordinal - b.citation.ordinal
  })
  const anchors = matches.slice(
    0,
    Math.min(MAX_RESULTS, options.maxResults ?? 6)
  )
  const byId = new Map<string, RetrievalResult>(
    anchors.map((match) => [String(match.citation.chunkId), match])
  )
  for (const match of anchors) {
    for (const result of await neighborsFor(
      ctx,
      projectId,
      match.citation.sourceId,
      match.citation.ordinal,
      options.neighborRadius,
      sourceNameCache
    ))
      byId.set(String(result.citation.chunkId), result)
  }
  return assembleRetrievedContext([...byId.values()], maxChars)
}

/** Normalizes and bounds user supplied exact search text. */
function boundedQuery(value: string): string {
  const query = value.trim()
  if (!query) throw new Error("Search query is required")
  if (query.length > MAX_QUERY_LENGTH)
    throw new Error("Search query is too long")
  return query
}

/** Appends a cited result without allowing one large chunk to exceed the context budget. */

/** Converts a persisted chunk into a citation carrying no source body metadata. */
async function resultForChunk(
  ctx: Pick<QueryCtx, "db">,
  chunk: Doc<"sourceChunks">,
  sourceNameCache: SourceNameCache = new Map()
): Promise<RetrievalResult | null> {
  // Always read the live source: a deleted source's chunks are purged in the
  // background and must not be cited meanwhile, and a renamed source should
  // be cited by its new name rather than the one stored on the chunk.
  const sourceKey = String(chunk.sourceId)
  let sourceFilename: string | undefined
  if (sourceNameCache.has(sourceKey)) {
    sourceFilename = sourceNameCache.get(sourceKey) ?? undefined
  } else {
    const source = await ctx.db.get(chunk.sourceId)
    const validSource = source?.projectId === chunk.projectId ? source : null
    sourceFilename = validSource?.filename
    sourceNameCache.set(sourceKey, sourceFilename ?? null)
  }
  if (!sourceFilename) return null
  return {
    text: chunk.text,
    citation: {
      sourceId: chunk.sourceId,
      sourceFilename,
      chunkId: chunk._id,
      ordinal: chunk.ordinal,
      references: chunk.references,
    },
  }
}

/** Returns exact, case-insensitive matches in deterministic source and chunk order. */
export const exactSearch = query({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    maxResults: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return exactSearchFor(ctx, args.projectId, args.query, args.maxResults)
  },
})

/** Reads one chunk by id after confirming it belongs to the requested project. */
export const readChunk = query({
  args: { projectId: v.id("projects"), chunkId: v.id("sourceChunks") },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.chunkId)
    if (!chunk || chunk.projectId !== args.projectId) return null
    return resultForChunk(ctx, chunk)
  },
})

/** Reads a bounded neighborhood around one chunk, including the anchor. */
export const readNeighbors = query({
  args: {
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    ordinal: v.number(),
    radius: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return neighborsFor(
      ctx,
      args.projectId,
      args.sourceId,
      args.ordinal,
      args.radius
    )
  },
})

/** Searches exact matches and assembles deduplicated, size bounded cited context. */
export const retrieveContext = query({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    maxResults: v.optional(v.number()),
    neighborRadius: v.optional(v.number()),
    maxChars: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const maxChars = Math.min(
      MAX_CONTEXT_CHARS,
      Math.max(500, Math.floor(args.maxChars ?? 8_000))
    )
    const sourceNameCache: SourceNameCache = new Map()
    const matches = await exactSearchFor(
      ctx,
      args.projectId,
      args.query,
      args.maxResults,
      sourceNameCache
    )
    const byId = new Map<string, RetrievalResult>(
      matches.map((match) => [String(match.citation.chunkId), match])
    )
    for (const match of matches) {
      const neighbors = await neighborsFor(
        ctx,
        args.projectId,
        match.citation.sourceId,
        match.citation.ordinal,
        args.neighborRadius,
        sourceNameCache
      )
      for (const result of neighbors)
        byId.set(String(result.citation.chunkId), result)
    }
    return assembleRetrievedContext([...byId.values()], maxChars)
  },
})

/** Validator for one persisted chunk row, shared with research imports. */
export const sourceChunkRow = v.object({
  ordinal: v.number(),
  text: v.string(),
  textHash: v.string(),
  startOffset: v.number(),
  endOffset: v.number(),
  sectionTitle: v.optional(v.string()),
  references: v.array(reference),
})

/**
 * Validates and inserts chunk rows for a source.
 *
 * @param options.ordinals Ordinals already written in this call; duplicates are rejected.
 * @throws When a chunk is oversized, out of order, or has a malformed hash.
 */
export async function insertSourceChunks(
  ctx: Pick<MutationCtx, "db">,
  source: Doc<"sources">,
  chunks: ReadonlyArray<typeof sourceChunkRow.type>,
  options: {
    ordinals?: Set<number>
    now?: number
    ingestionJobId?: Id<"ingestionJobs">
  } = {}
): Promise<void> {
  const ordinals = options.ordinals ?? new Set<number>()
  const now = options.now ?? Date.now()
  for (const chunk of chunks) {
    if (
      chunk.text.length > MAX_CHUNK_TEXT ||
      chunk.ordinal < 0 ||
      !Number.isInteger(chunk.ordinal) ||
      ordinals.has(chunk.ordinal) ||
      chunk.endOffset < chunk.startOffset ||
      !/^[a-f0-9]{8,128}$/i.test(chunk.textHash)
    )
      throw new Error("Invalid source chunk")
    ordinals.add(chunk.ordinal)
    await ctx.db.insert("sourceChunks", {
      ...chunk,
      projectId: source.projectId,
      sourceId: source._id,
      sourceFilename: source.filename,
      ...(options.ingestionJobId
        ? { ingestionJobId: options.ingestionJobId }
        : {}),
      createdAt: now,
    })
  }
}

/** Persists one bounded ingestion batch after validating project and source ownership. */
export const replaceChunks = mutation({
  args: {
    projectId: v.id("projects"),
    sourceId: v.id("sources"),
    ingestionJobId: v.optional(v.id("ingestionJobs")),
    leaseToken: v.optional(v.string()),
    /**
     * Adds this batch after earlier ones instead of replacing the source's
     * chunks. Large sources are written as one replacing batch, then appends.
     */
    append: v.optional(v.boolean()),
    chunks: v.array(sourceChunkRow),
  },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId)
    if (!source || source.projectId !== args.projectId)
      throw new Error("Source does not belong to project")
    if (source.unsupported)
      throw new Error(
        "Unsupported source text needs explicit derived-source approval before indexing"
      )
    if (args.ingestionJobId) {
      const job = await ctx.db.get(args.ingestionJobId)
      if (
        !job ||
        job.projectId !== args.projectId ||
        job.sourceId !== args.sourceId
      )
        throw new Error("Ingestion job does not belong to source")
      if (
        job.leaseToken !== args.leaseToken ||
        (job.leaseExpiresAt ?? 0) <= Date.now()
      )
        throw new Error("Ingestion lease expired")
    }
    if (args.chunks.length > 500) throw new Error("Chunk batch is too large")
    const ordinals = new Set<number>()
    if (!args.append) {
      const existing = await ctx.db
        .query("sourceChunks")
        .withIndex("by_source_ordinal", (q) => q.eq("sourceId", args.sourceId))
        .collect()
      for (const chunk of existing) await ctx.db.delete(chunk._id)
    }
    const now = Date.now()
    await insertSourceChunks(ctx, source, args.chunks, {
      ordinals,
      now,
      ...(args.ingestionJobId ? { ingestionJobId: args.ingestionJobId } : {}),
    })
    const oldOutlines = await ctx.db
      .query("sourceOutlines")
      .withIndex("by_source_ordinal", (q) => q.eq("sourceId", args.sourceId))
      .take(501)
    for (const outline of oldOutlines) await ctx.db.delete(outline._id)
    for (const chunk of args.chunks) {
      await ctx.db.insert("sourceOutlines", {
        projectId: args.projectId,
        sourceId: args.sourceId,
        ordinal: chunk.ordinal,
        title:
          chunk.sectionTitle ?? chunk.references[0]?.label ?? source.filename,
        startChunkOrdinal: chunk.ordinal,
        endChunkOrdinal: chunk.ordinal,
        createdAt: now,
      })
    }
    return { count: args.chunks.length }
  },
})
