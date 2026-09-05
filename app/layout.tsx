/** Defines the root document, global providers, fonts, and shared application shell. */

import type { Metadata } from "next"
import "@fontsource-variable/instrument-sans"
import "./globals.css"
import { AppShell } from "@/components/app-shell"
import { ConvexClientProvider } from "@/components/convex-client-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { BackgroundNotices } from "@/components/background-notices"

/** Default metadata used for Blitz routes. */
export const metadata: Metadata = {
  title: "Blitz | Learn at speed",
  description: "Turn your study material into a focused learning feed.",
}

/** Wraps every route with theme, Convex, and navigation providers. */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <ConvexClientProvider>
            <BackgroundNotices>
              <AppShell>{children}</AppShell>
            </BackgroundNotices>
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
