"use client"

/** Creates the browser Convex client and reports missing runtime configuration. */

import type { ReactNode } from "react"
import { ConvexProvider, ConvexReactClient } from "convex/react"

/** Public deployment URL supplied by local or hosted Convex configuration. */
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null

/** Children rendered within the configured Convex context. */
type ConvexClientProviderProps = {
  children: ReactNode
}

/** Provides the shared Convex client to the app without requiring auth. */
export function ConvexClientProvider({ children }: ConvexClientProviderProps) {
  if (!convexClient) {
    return (
      <div role="alert">
        Convex is not configured. Set NEXT_PUBLIC_CONVEX_URL in .env.local and
        restart the development server.
      </div>
    )
  }

  return <ConvexProvider client={convexClient}>{children}</ConvexProvider>
}
