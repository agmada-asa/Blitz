/** Resolves chat-owned source context and saves immutable, navigable passages before generation. */
import { mutation, query } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  chunkPassages,
  sourcePassages,
  passageScore,
  type ChatCitation,
} from "../lib/citations"
import { retrieveProjectContext } from "./sourceRetrieval"

/** Registers an extracted upload in its project without enqueueing study generation. */
export const createDocument = mutation({
  args: {
    projectId: v.optional(v.id("projects")),
    ownerToken: v.optional(v.string()),
    filename: v.string(),
    relativeKey: v.string(),
    textKey: v.optional(v.string()),
    mimeType: v.string(),
    text: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    if (!args.projectId && !args.ownerToken)
      throw new Error("Chat document owner is required")
    if (args.ownerToken && !/^[A-Za-z0-9_-]{32,256}$/.test(args.ownerToken))
      throw new Error("Chat upload token is invalid")
    if (args.projectId && !(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    if (
      !(
        /^Sources\/[a-f0-9]{64}-[^/\\]+$/.test(args.relativeKey) ||
        /^Uploads\/[a-f0-9]{64}-[^/\\]+$/.test(args.relativeKey)
      ) ||
      // Full text lives in the same storage folder as its original.
      (args.textKey !== undefined &&
        (!/^(Sources|Uploads)\/[a-f0-9]{64}\.pages\.txt$/.test(args.textKey) ||
          args.textKey.split("/")[0] !== args.relativeKey.split("/")[0])) ||
      !args.text.trim() ||
      new TextEncoder().encode(args.text).length > 500_000 ||
      args.filename.length > 255 ||
      !Number.isSafeInteger(args.sizeBytes) ||
      args.sizeBytes < 1
    )
      throw new Error("Chat upload is invalid")
    return ctx.db.insert("chatDocuments", { ...args, createdAt: Date.now() })
  },
})

/** Resolves an uploaded document through its project, chat, or pre-chat token owner. */
export const getDocument = query({
  args: {
    projectId: v.optional(v.id("projects")),
    chatId: v.optional(v.id("workspaceChats")),
    ownerToken: v.optional(v.string()),
    documentId: v.id("chatDocuments"),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId)
    if (!document) return null
    if (args.projectId && document.projectId !== args.projectId) return null
    if (args.chatId && document.chatId !== args.chatId) return null
    if (args.ownerToken && document.ownerToken !== args.ownerToken) return null
    if (args.ownerToken && document.chatId && document.chatId !== args.chatId)
      return null
    if (!args.projectId && !args.chatId && !args.ownerToken) return null
    return document
  },
})

/** Retrieves project passages once per question, with their source identity intact. */
export const projectPassages = query({
  args: { projectId: v.id("projects"), question: v.string() },
  handler: async (ctx, args) => {
    const question = args.question.trim()
    if (!question) return { results: [], characterCount: 0 }
    return retrieveProjectContext(ctx, args.projectId, question.slice(0, 500), {
      maxChars: 16_000,
      neighborRadius: 1,
    })
  },
})

/** Creates the citation manifest from persisted attachments and verified retrieved chunk IDs. */
export const prepare = mutation({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    question: v.string(),
    chunkIds: v.array(v.id("sourceChunks")),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId)
    const message = await ctx.db.get(args.messageId)
    if (
      !chat ||
      !message ||
      message.chatId !== chat._id ||
      chat.activeMessageId !== message._id ||
      message.status !== "running"
    )
      throw new Error("Chat turn is no longer active")
    if (args.chunkIds.length > 60) throw new Error("Too many source passages")
    const attachments = await ctx.db
      .query("workspaceChatAttachments")
      .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chat._id))
      .order("desc")
      .take(32)
    const projects = new Set(
      [chat.projectId, ...attachments.map((item) => item.projectId)].filter(
        Boolean
      )
    )
    const candidates: ChatCitation[] = []
    const namespace = `${message._id}_${Date.now().toString(36)}`
    /** Attaches server-owned identity to exact text spans and assigns message-scoped link IDs. */
    const add = (
      text: string,
      target: Pick<
        ChatCitation,
        "filename" | "projectId" | "sourceId" | "documentId" | "attachmentId"
      >,
      baseOffset = 0,
      page?: number
    ) => {
      for (const passage of sourcePassages(text))
        candidates.push({
          ...passage,
          ...target,
          ...(page && !passage.page ? { page, label: `Page ${page}` } : {}),
          startOffset: passage.startOffset + baseOffset,
          endOffset: passage.endOffset + baseOffset,
          id: `${namespace}_${candidates.length}`,
        })
    }
    for (const attachment of attachments) {
      if (attachment.documentId) {
        const document = await ctx.db.get(attachment.documentId)
        if (
          document &&
          ((chat.projectId && document.projectId === chat.projectId) ||
            document.chatId === chat._id)
        )
          add(document.text, {
            filename: document.filename,
            ...(document.projectId ? { projectId: document.projectId } : {}),
            documentId: document._id,
          })
      } else if (attachment.kind === "card" && attachment.itemId) {
        const item = await ctx.db.get(attachment.itemId)
        const chunk = item?.sourceChunkId
          ? await ctx.db.get(item.sourceChunkId)
          : null
        const job = chunk ? await ctx.db.get(chunk.jobId) : null
        const source = job ? await ctx.db.get(job.sourceId) : null
        if (job && source && job.projectId === attachment.projectId)
          add(job.sourceTextSnapshot.slice(0, 48_000), {
            filename: source.filename,
            projectId: job.projectId,
            sourceId: source._id,
            attachmentId: attachment._id,
          })
      } else if (attachment.text) {
        add(attachment.text, {
          filename: attachment.label,
          attachmentId: attachment._id,
        })
      }
    }
    // Read and split each source once: every read counts towards the function's
    // 16 MB limit, and 60 chunks of one long PDF would otherwise exceed it.
    const sources = new Map<
      Id<"sources">,
      { source: Doc<"sources">; passages: ReturnType<typeof sourcePassages> } | null
    >()
    for (const chunkId of new Set(args.chunkIds)) {
      const chunk = await ctx.db.get(chunkId)
      if (!chunk || !projects.has(chunk.projectId)) continue
      if (!sources.has(chunk.sourceId)) {
        const source = await ctx.db.get(chunk.sourceId)
        sources.set(
          chunk.sourceId,
          source
            ? { source, passages: sourcePassages(source.extractedText) }
            : null
        )
      }
      const entry = sources.get(chunk.sourceId)
      if (!entry || entry.source.projectId !== chunk.projectId) continue
      const { source, passages } = entry
      const target = {
        filename: source.filename,
        projectId: source.projectId,
        sourceId: source._id,
      }
      // Large sources (whole books) keep only an excerpt on the source row.
      // Chunks past it are split on their own, taking their page from the
      // markers ingestion recorded, so every part of a book stays citable.
      if (chunk.endOffset > source.extractedText.length) {
        for (const passage of chunkPassages(chunk))
          candidates.push({
            ...passage,
            ...target,
            chunkId: chunk._id,
            id: `${namespace}_${candidates.length}`,
          })
        continue
      }
      // Split from the full source so a chunk starting mid-page retains its page marker.
      for (const passage of passages) {
        if (
          passage.endOffset <= chunk.startOffset ||
          passage.startOffset >= chunk.endOffset
        )
          continue
        candidates.push({
          ...passage,
          ...target,
          id: `${namespace}_${candidates.length}`,
        })
      }
    }
    candidates.sort(
      (a, b) => passageScore(b, args.question) - passageScore(a, args.question)
    )
    const selected: ChatCitation[] = []
    const seen = new Set<string>()
    let remaining = 48_000
    /** Adds a bounded snapshot once, preserving the complete passage and its stable link ID. */
    const select = (citation: ChatCitation) => {
      const key = `${citation.documentId ?? citation.sourceId ?? citation.attachmentId}:${citation.startOffset}:${citation.text}`
      if (
        seen.has(key) ||
        citation.text.length > remaining ||
        selected.length >= 80
      )
        return
      seen.add(key)
      selected.push(citation)
      remaining -= citation.text.length
    }
    // Retain prior cited passages for follow-ups and continued responses before adding new context.
    const previous = await ctx.db
      .query("workspaceChatMessages")
      .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chat._id))
      .order("desc")
      .take(24)
    for (const prior of previous)
      for (const citation of prior.citations ?? []) {
        if (
          (remaining > 32_000 || prior._id === message._id) &&
          prior.content.includes(`citation:${citation.id}`)
        )
          select(citation)
      }
    // Reserve one passage per source so a large document cannot hide another attachment.
    const represented = new Set<string>()
    for (const citation of candidates) {
      const target =
        citation.documentId ??
        citation.sourceId ??
        citation.attachmentId ??
        citation.id
      if (!represented.has(target)) {
        represented.add(target)
        select(citation)
      }
    }
    for (const citation of candidates) select(citation)
    await ctx.db.patch(message._id, { citations: selected })
    return selected
  },
})

/** Reads a citation only through its owning chat and message; the saved excerpt survives source deletion. */
export const read = query({
  args: {
    chatId: v.id("workspaceChats"),
    messageId: v.id("workspaceChatMessages"),
    citationId: v.string(),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId)
    if (!message || message.chatId !== args.chatId) return null
    const citation = message.citations?.find(
      (item) => item.id === args.citationId
    )
    if (!citation) return null
    let text = citation.text
    let fileUrl: string | undefined
    let mimeType: string | undefined
    let originalUrl: string | undefined
    /** Offset of `text` within the full source when it is one section of a book. */
    let chunkBase = 0
    if (citation.documentId && citation.projectId) {
      const document = await ctx.db.get(
        citation.documentId as Id<"chatDocuments">
      )
      if (document?.projectId === citation.projectId) {
        text = document.text
        mimeType = document.mimeType
        fileUrl = `/api/chat/files?projectId=${encodeURIComponent(document.projectId)}&documentId=${encodeURIComponent(document._id)}`
      }
    } else if (citation.documentId) {
      const document = await ctx.db.get(
        citation.documentId as Id<"chatDocuments">
      )
      if (document?.chatId === args.chatId) {
        text = document.text
        mimeType = document.mimeType
        fileUrl = `/api/chat/files?chatId=${encodeURIComponent(args.chatId)}&ownerToken=${encodeURIComponent(document.ownerToken ?? "")}&documentId=${encodeURIComponent(document._id)}`
      }
    } else if (citation.sourceId && citation.projectId) {
      const source = await ctx.db.get(citation.sourceId as Id<"sources">)
      if (source?.projectId === citation.projectId) {
        text = source.extractedText
        mimeType =
          source.mimeType ??
          (source.kind === "pdf" ? "application/pdf" : "text/plain")
        originalUrl = source.originalUrl
        if (source.relativeKey)
          fileUrl = `/api/sources/file?projectId=${encodeURIComponent(source.projectId)}&sourceId=${encodeURIComponent(source._id)}&inline=1`
        // Passages past the stored excerpt of a book are shown within their section.
        if (citation.chunkId) {
          const chunk = await ctx.db.get(
            citation.chunkId as Id<"sourceChunks">
          )
          if (chunk?.sourceId === source._id) {
            text = chunk.text
            chunkBase = chunk.startOffset
          }
        }
      }
    } else if (citation.attachmentId) {
      const attachment = await ctx.db.get(
        citation.attachmentId as Id<"workspaceChatAttachments">
      )
      // Branches retain the snapshot even if the original attachment has been removed.
      if (attachment?.text) {
        text = attachment.text
        originalUrl = attachment.url
      }
    }
    const savedStart = citation.startOffset - chunkBase
    const start =
      text.slice(savedStart, citation.endOffset - chunkBase) === citation.text
        ? savedStart
        : text.indexOf(citation.text)
    const matches = start >= 0
    return {
      citation,
      text: matches ? text : citation.text,
      startOffset: matches ? start : 0,
      endOffset: matches ? start + citation.text.length : citation.text.length,
      snapshotOnly: !matches || text === citation.text,
      fileUrl,
      mimeType,
      originalUrl,
    }
  },
})
