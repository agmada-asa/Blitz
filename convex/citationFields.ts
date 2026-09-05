/** Shares the persisted citation validator between the schema and chat mutations. */
import { v } from "convex/values"

/** Immutable text and identifiers for one allowed citation target in an assistant message. */
export const citationFields = v.object({
  id: v.string(),
  filename: v.string(),
  label: v.string(),
  text: v.string(),
  startOffset: v.number(),
  endOffset: v.number(),
  page: v.optional(v.number()),
  projectId: v.optional(v.string()),
  sourceId: v.optional(v.string()),
  documentId: v.optional(v.string()),
  attachmentId: v.optional(v.string()),
})
