/** Computes a deterministic, non-secret identity for an extracted source part. */

/** Inputs that define one retryable source part identity. */
export type SourceFingerprintInput = {
  filename: string
  kind: string
  text: string
  originalUrl?: string
}

/** Runs a small deterministic 32-bit hash over UTF-16 code units. */
function hashText(text: string, seed: number, prime: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, prime)
  }
  return hash >>> 0
}

/** Returns a bounded fingerprint suitable for an indexed idempotency lookup. */
export function sourceImportFingerprint(input: SourceFingerprintInput): string {
  const value = `${input.kind}\u0000${input.filename}\u0000${input.originalUrl ?? ""}\u0000${input.text}`
  const first = hashText(value, 0x811c9dc5, 0x01000193)
  const second = hashText(value, 0x9e3779b9, 0x01000193 ^ 0x45d9f3b)
  return `v1-${first.toString(16).padStart(8, "0")}-${second
    .toString(16)
    .padStart(8, "0")}`
}
