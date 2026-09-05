/** Presents durable preparation work so navigation does not hide local progress. */

import { ActivityList } from "@/components/activity/activity-list"

/** Renders the activity route and its short worker continuity note. */
export default function ActivityPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <div className="mb-8">
        <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          Activity
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Preparation continues on your Mac while it is awake, even if you leave
          this page.
        </p>
      </div>
      <ActivityList />
    </main>
  )
}
