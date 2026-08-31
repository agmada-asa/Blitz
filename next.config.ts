/** Configures Next.js development access for the optional local-network runner. */

import type { NextConfig } from "next"

/** Allows only the LAN address discovered by the development launcher. */
const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.BLITZ_LAN_ADDRESS
    ? [process.env.BLITZ_LAN_ADDRESS]
    : [],
}

export default nextConfig
