/** Presents ongoing work and recent results in one notification center. */

import { NotificationCenter } from "@/components/notifications/notification-center"

/** Renders the notification center route. */
export default function NotificationsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 pb-24 sm:px-6 sm:py-8">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-medium tracking-tight sm:text-3xl">
          Notifications
        </h1>
        <p className="mt-1 max-w-xl text-xs sm:text-sm text-muted-foreground">
          Follow practice questions, exam papers, marking, research, and AI replies. Each notification
          opens where the work happened.
        </p>
      </div>
      <NotificationCenter />
    </main>
  )
}
