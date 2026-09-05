/** Configures Next.js development access for the optional local-network runner. */

import type { NextConfig } from "next"

/** Allows only the LAN address discovered by the development launcher. */
const nextConfig: NextConfig = {
  // Desktop development uses its own trace and lock directory beside the LAN app.
  distDir: process.env.BLITZ_NEXT_DIST_DIR || ".next",
  // Keep the development badge from covering the full-screen feed controls.
  devIndicators: false,
  allowedDevOrigins: [
    "127.0.0.1",
    ...(process.env.BLITZ_LAN_ADDRESS ? [process.env.BLITZ_LAN_ADDRESS] : []),
  ],
}

export default nextConfig
