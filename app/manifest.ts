import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Blitz",
    short_name: "Blitz",
    description: "Turn course material into a focused learning feed.",
    start_url: "/",
    display: "standalone",
    background_color: "#0d0d0d",
    theme_color: "#ffd60a",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  }
}
