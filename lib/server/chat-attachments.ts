/** Validates native chat image metadata and bytes before provider delivery. */

/** Native image formats supported by the provider attachment contract. */
export const CHAT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number]

/** Maximum original image size retained for one chat attachment. */
export const MAX_CHAT_IMAGE_BYTES = 5_000_000

/** Returns whether a MIME type is one of the supported native image formats. */
export function isChatImageMimeType(
  value: string | null | undefined
): value is ChatImageMimeType {
  return CHAT_IMAGE_MIME_TYPES.includes(
    (value?.split(";", 1)[0].trim().toLowerCase() ?? "") as ChatImageMimeType
  )
}

/** Verifies a bounded image buffer matches its claimed supported MIME type. */
export function validateChatImageBytes(
  bytes: Uint8Array,
  mimeType: ChatImageMimeType
): void {
  if (bytes.byteLength < 12 || bytes.byteLength > MAX_CHAT_IMAGE_BYTES)
    throw new Error("Chat image is too large or empty.")
  const startsWith = (...values: number[]): boolean =>
    values.every((value, index) => bytes[index] === value)
  const png = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  const jpeg = startsWith(0xff, 0xd8, 0xff)
  const gif =
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  const webp =
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  if (
    (mimeType === "image/png" && !png) ||
    (mimeType === "image/jpeg" && !jpeg) ||
    (mimeType === "image/gif" && !gif) ||
    (mimeType === "image/webp" && !webp)
  )
    throw new Error("The image content does not match its file type.")
}
