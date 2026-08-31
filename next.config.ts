import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.BLITZ_LAN_ADDRESS
    ? [process.env.BLITZ_LAN_ADDRESS]
    : [],
}

export default nextConfig
