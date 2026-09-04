/** Configures Next.js development access for the optional local-network runner. */

import type { NextConfig } from "next"

/** Allows only the LAN address discovered by the development launcher. */
const nextConfig: NextConfig = {
  // Keep the development badge from covering the full-screen feed controls.
  devIndicators: false,
  allowedDevOrigins: process.env.BLITZ_LAN_ADDRESS
    ? [process.env.BLITZ_LAN_ADDRESS]
    : [],
}

export default nextConfig
