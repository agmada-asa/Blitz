/** Defines install metadata and display settings for the Blitz web app. */

import type { MetadataRoute } from "next"

/** Returns the web app manifest consumed by Next.js metadata routing. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Blitz",
    short_name: "Blitz",
    description: "Turn course material into a focused learning feed.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#101010",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/apple-icon.png",
        sizes: "1000x1000",
        type: "image/png",
      },
    ],
  }
}
