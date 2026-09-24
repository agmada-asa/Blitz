/** Normalizes browser file, drop, and clipboard inputs before upload. */

/** Minimal browser file shape needed to classify composer input. */
export type ComposerFile = {
  readonly type: string
}

/** Native image MIME types accepted by the chat composer. */
export const COMPOSER_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
])

/** Returns whether a file can be delivered as a native image attachment. */
export function isComposerImageFile(file: ComposerFile): boolean {
  return COMPOSER_IMAGE_MIME_TYPES.has(file.type.toLowerCase())
}

/** Selects clipboard images and preserves their original order. */
export function clipboardImageFiles<T extends ComposerFile>(
  files: readonly T[]
): T[] {
  return files.filter(isComposerImageFile)
}

/** Selects dropped files and preserves their original order. */
export function droppedFiles<T extends ComposerFile>(files: readonly T[]): T[] {
  return [...files]
}
