/**
 * Writes the small platform files `install-desktop.mjs` needs that no
 * installed tool makes: a Windows `.ico` and a Linux `.desktop` `Exec` line.
 * Kept apart from the installer, which runs on import, so tests can check them.
 */

/**
 * Packs PNG images into a Windows `.ico`. Since Windows Vista an icon entry
 * may hold a PNG as it is, so the file is a header, one 16-byte directory
 * entry per image, then the images.
 * @param {Array<{size: number, png: Buffer}>} images Square images, at most 256 px.
 * @returns {Buffer} The `.ico` file.
 */
export function packIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)
  let offset = header.length + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    // A width or height of 0 means 256.
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2) // no palette
    entry.writeUInt8(0, 3) // reserved
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)])
}

/**
 * Quotes one argument for a `.desktop` file's `Exec` line, as the Desktop
 * Entry Specification requires for paths with spaces or reserved characters.
 * @param {string} value The argument.
 * @returns {string} The argument as it is, or double-quoted with `"`, `` ` ``,
 *   `$` and `\` escaped.
 */
export function desktopExecQuote(value) {
  if (!/[\s"'\\`$<>~|&;*?#()]/.test(value)) return value
  return `"${value.replace(/["`$\\]/g, (character) => `\\${character}`)}"`
}
