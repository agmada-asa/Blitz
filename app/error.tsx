"use client"

/** Provides a recoverable fallback when a route or its data connection crashes. */

import Link from "next/link"

import { Button } from "@/components/ui/button"

/** Props supplied by Next.js to the route-level error boundary. */
type ErrorPageProps = {
  error: Error & { digest?: string }
  retry: () => void
}

/** Renders a safe recovery screen without exposing internal error details. */
export default function ErrorPage({ error, retry }: ErrorPageProps) {
  // Keep query and server details out of the user-facing fallback copy.
  void error

  return (
    <main className="mx-auto flex min-h-[60svh] w-full max-w-5xl flex-col items-center justify-center px-5 pb-28 text-center sm:px-8">
      <div role="alert">
        <h1 className="font-heading text-3xl">This page couldn&apos;t load.</h1>
        <p className="mt-3 text-muted-foreground">
          Try again, or return to your project library.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Button onClick={retry} className="rounded-full">
            Try again
          </Button>
          <Button asChild variant="outline" className="rounded-full">
            <Link href="/">Back to projects</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
