/** Configures Next.js and permits this Mac's LAN and tailnet development entry points. */

import type { NextConfig } from "next"
import { execFileSync } from "node:child_process"

/** Returns the exact Tailscale names and addresses assigned to this Mac. */
function discoverTailnetOrigins(): string[] {
  const origins = new Set<string>()
  const configuredHost = process.env.BLITZ_TAILNET_HOST?.trim()
  if (configuredHost) origins.add(configuredHost.replace(/\.$/, ""))

  try {
    const status = JSON.parse(
      execFileSync("tailscale", ["status", "--json"], {
        encoding: "utf8",
        timeout: 1_500,
        stdio: ["ignore", "pipe", "ignore"],
      })
    ) as {
      Self?: { DNSName?: unknown; TailscaleIPs?: unknown }
    }
    const dnsName = status.Self?.DNSName
    if (typeof dnsName === "string" && dnsName.trim())
      origins.add(dnsName.trim().replace(/\.$/, ""))
    const addresses = status.Self?.TailscaleIPs
    if (Array.isArray(addresses))
      for (const address of addresses)
        if (typeof address === "string" && address.trim())
          origins.add(address.trim())
  } catch {
    // Tailscale is optional; the LAN runner still works without its CLI or network.
  }

  return [...origins]
}

/** Allows loopback plus this Mac's discovered LAN and Tailscale addresses. */
const nextConfig: NextConfig = {
  // Desktop development uses its own trace and lock directory beside the LAN app.
  distDir: process.env.BLITZ_NEXT_DIST_DIR || ".next",
  // PDF.js loads its worker relative to the installed package at runtime.
  serverExternalPackages: ["pdfjs-dist"],
  // Keep the development badge from covering the full-screen feed controls.
  devIndicators: false,
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.BLITZ_LAN_ADDRESS ? [process.env.BLITZ_LAN_ADDRESS] : []),
    ...discoverTailnetOrigins(),
  ],
}

export default nextConfig
