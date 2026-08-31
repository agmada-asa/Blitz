import type { Metadata } from "next"
import "@fontsource/bbh-bartle"
import "@fontsource-variable/instrument-sans"
import "./globals.css"
import { AppShell } from "@/components/app-shell"
import { ConvexClientProvider } from "@/components/convex-client-provider"
import { ThemeProvider } from "@/components/theme-provider"

export const metadata: Metadata = {
  title: "Blitz — Learn at speed",
  description: "Turn your study material into a focused learning feed.",
}

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
            <AppShell>{children}</AppShell>
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
