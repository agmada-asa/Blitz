/** Computes safe multipart research-import checkpoints without database access. */

/** Validates a multipart import's durable ordering before writing a checkpoint. */
export function validateResearchImportPartSequence(args: {
  existingPartCount: number
  partNumber: number
  totalParts: number
}): void {
  if (
    !Number.isSafeInteger(args.existingPartCount) ||
    !Number.isSafeInteger(args.partNumber) ||
    !Number.isSafeInteger(args.totalParts) ||
    args.existingPartCount < 0 ||
    args.partNumber < 1 ||
    args.totalParts < 1 ||
    args.partNumber > args.totalParts ||
    args.totalParts > 32 ||
    args.partNumber > args.existingPartCount + 1
  )
    throw new Error("Research import part checkpoint is invalid")
}

/** Builds the atomic source-import checkpoint and lease transition. */
export function buildResearchImportCheckpoint<
  SourceId extends string,
  PreparationJobId extends string,
>(args: {
  existingSourceIds: readonly SourceId[]
  existingPreparationJobIds: readonly PreparationJobId[]
  sourceId: SourceId
  preparationJobId: PreparationJobId
  totalParts: number
}): {
  status: "running" | "imported"
  sourceIds: SourceId[]
  preparationJobIds: PreparationJobId[]
  clearLease: boolean
} {
  if (
    args.existingSourceIds.length !== args.existingPreparationJobIds.length ||
    !args.sourceId ||
    !args.preparationJobId ||
    !Number.isSafeInteger(args.totalParts) ||
    args.totalParts < 1 ||
    args.totalParts > 32
  )
    throw new Error("Research import part checkpoint is invalid")
  const sourceIds = [...args.existingSourceIds, args.sourceId]
  const preparationJobIds = [
    ...args.existingPreparationJobIds,
    args.preparationJobId,
  ]
  const complete = sourceIds.length === args.totalParts
  if (sourceIds.length > args.totalParts)
    throw new Error("Research import part checkpoint is invalid")
  return {
    status: complete ? "imported" : "running",
    sourceIds,
    preparationJobIds,
    clearLease: complete,
  }
}

/** Checks that a replayed multipart source still matches its durable source row. */
export function researchImportPartMatchesSource(args: {
  existingSource:
    | {
        filename: string
        kind: "pdf" | "markdown" | "text" | "paste"
        extractedText: string
        originalUrl?: string
      }
    | null
    | undefined
  filename: string
  kind: "pdf" | "markdown" | "text" | "paste"
  extractedText: string
  originalUrl: string
}): boolean {
  return Boolean(
    args.existingSource &&
      args.existingSource.filename === args.filename &&
      args.existingSource.kind === args.kind &&
      args.existingSource.extractedText === args.extractedText &&
      args.existingSource.originalUrl === args.originalUrl
  )
}
