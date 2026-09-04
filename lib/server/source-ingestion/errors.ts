/** Provides structured, user-actionable errors for source ingestion boundaries. */

/** Stable failure codes that callers can map to recovery copy or retry behavior. */
export type SourceIngestionErrorCode =
  | "invalid-input"
  | "input-too-large"
  | "chunk-limit-exceeded"
  | "invalid-url"
  | "private-url"
  | "url-resolution-failed"
  | "url-fetch-failed"
  | "url-too-large"
  | "url-timeout"
  | "url-redirect-limit"

/** Error carrying a safe code and bounded context for an ingestion failure. */
export class SourceIngestionError extends Error {
  /** Machine-readable reason for the failure. */
  readonly code: SourceIngestionErrorCode
  /** Safe context suitable for server logs and recovery messages. */
  readonly context: Readonly<Record<string, string | number>>

  /** Creates an ingestion error without retaining source contents or credentials. */
  constructor(
    code: SourceIngestionErrorCode,
    message: string,
    context: Readonly<Record<string, string | number>> = {}
  ) {
    super(message)
    this.name = "SourceIngestionError"
    this.code = code
    this.context = context
  }
}
