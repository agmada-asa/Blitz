/** Defines the root document, global providers, fonts, and shared application shell. */

import type { Metadata } from "next"
import "@fontsource-variable/instrument-sans"
import "./globals.css"
import { AppShell } from "@/components/app-shell"
import { ConvexClientProvider } from "@/components/convex-client-provider"
import { ThemeProvider } from "@/components/theme-provider"
import { BackgroundNotices } from "@/components/background-notices"
import { NotificationProvider } from "@/components/notifications/notification-provider"

/** Default metadata used for Blitz routes. */
export const metadata: Metadata = {
  title: "Blitz | Learn at speed",
  description: "Turn your study material into a focused learning feed.",
}

/** Applies a saved accent before the first paint on a full page load. */
const accentBootstrapScript =
  '(function(){try{var a=localStorage.getItem("blitz-accent");if(["red","orange","yellow","green","blue","indigo","violet"].indexOf(a)!==-1)document.documentElement.setAttribute("data-accent",a)}catch(e){}})()'

/** Wraps every route with theme, Convex, and navigation providers. */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" data-accent="orange" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: accentBootstrapScript }} />
      </head>
      <body>
        <ThemeProvider>
          <ConvexClientProvider>
            <BackgroundNotices>
              <NotificationProvider>
                <AppShell>{children}</AppShell>
              </NotificationProvider>
            </BackgroundNotices>
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
