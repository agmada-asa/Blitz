/** Owns terminal QR code rendering for local LAN development URLs. */

import QRCode from "qrcode"

/**
 * Formats a terminal-friendly QR code string for a given URL.
 *
 * Uses compact half-block characters and ANSI styling so that mobile device
 * cameras can scan the displayed code against either dark or light terminal
 * backgrounds.
 *
 * @param {string} url - The URL to encode as a terminal QR code.
 * @returns {Promise<string>} The rendered terminal QR code string.
 */
export async function formatTerminalQr(url) {
  return QRCode.toString(url, {
    type: "terminal",
    small: true,
  })
}
