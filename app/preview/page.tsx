/** Exposes the self-contained visual checkpoint for Blitz's feed direction. */

import type { Metadata } from "next"

import { PreviewFeed } from "@/components/preview/preview-feed"

/** Browser metadata for the fixture-driven preview route. */
export const metadata: Metadata = {
  title: "Blitz preview | Learn at speed",
  description: "An interactive, local-only preview of the Blitz learning feed.",
}

/** Renders the local preview without querying Convex or persisting progress. */
export default function PreviewPage() {
  return <PreviewFeed />
}
