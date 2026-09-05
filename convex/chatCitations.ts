/** Resolves chat-owned source context and saves immutable, navigable passages before generation. */
import { mutation, query } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"
import {
  sourcePassages,
  passageScore,
  type ChatCitation,
} from "../lib/citations"
import { retrieveProjectContext } from "./sourceRetrieval"

/** Registers an extracted upload in its project without enqueueing study generation. */
export const createDocument = mutation({
  args: {
    projectId: v.id("projects"),
    filename: v.string(),
    relativeKey: v.string(),
    mimeType: v.string(),
    text: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.projectId)))
      throw new Error("Project not found")
    if (
      !/^Sources\/[a-f0-9]{64}-[^/\\]+$/.test(args.relativeKey) ||
      !args.text.trim() ||
      new TextEncoder().encode(args.text).length > 500_000 ||
      args.filename.length > 255 ||
      !Number.isSafeInteger(args.sizeBytes) ||
      args.sizeBytes < 1 ||
      args.sizeBytes > 50_000_000
    )
      throw new Error("Chat upload is invalid")
    return ctx.db.insert("chatDocuments", { ...args, createdAt: Date.now() })
  },
})

/** Resolves an uploaded document only in its owning project. */
export const getDocument = query({
  args: { projectId: v.id("projects"), documentId: v.id("chatDocuments") },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId)
    return document?.projectId === args.projectId ? document : null
  },
})

/** Retrieves project passages once per question, with their source identity intact. */
export const projectPassages = query({
  args: { projectId: v.id("projects"), question: v.string() },
  handler: async (ctx, args) =>
    retrieveProjectContext(ctx, args.projectId, args.question.slice(0, 500), {
      maxChars: 16_000,
      neighborRadius: 1,
    }),
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
        if (document && document.projectId === chat.projectId)
          add(document.text, {
            filename: document.filename,
            projectId: document.projectId,
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
    for (const chunkId of new Set(args.chunkIds)) {
      const chunk = await ctx.db.get(chunkId)
      if (!chunk || !projects.has(chunk.projectId)) continue
      const source = await ctx.db.get(chunk.sourceId)
      if (!source || source.projectId !== chunk.projectId) continue
      // Split from the full source so a chunk starting mid-page retains its page marker.
      for (const passage of sourcePassages(source.extractedText)) {
        if (
          passage.endOffset <= chunk.startOffset ||
          passage.startOffset >= chunk.endOffset
        )
          continue
        candidates.push({
          ...passage,
          filename: source.filename,
          projectId: source.projectId,
          sourceId: source._id,
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
    if (citation.documentId && citation.projectId) {
      const document = await ctx.db.get(
        citation.documentId as Id<"chatDocuments">
      )
      if (document?.projectId === citation.projectId) {
        text = document.text
        mimeType = document.mimeType
        fileUrl = `/api/chat/files?projectId=${encodeURIComponent(document.projectId)}&documentId=${encodeURIComponent(document._id)}`
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
    const start =
      text.slice(citation.startOffset, citation.endOffset) === citation.text
        ? citation.startOffset
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
