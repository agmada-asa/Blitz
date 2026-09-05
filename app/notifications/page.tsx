/** Presents ongoing work and recent results in one notification center. */

import { NotificationCenter } from "@/components/notifications/notification-center"

/** Renders the notification center route. */
export default function NotificationsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <div className="mb-8">
        <h1 className="font-heading text-3xl font-medium tracking-tight sm:text-4xl">
          Notifications
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Follow research, source preparation, and AI replies. Each notification
          opens where the work happened.
        </p>
      </div>
      <NotificationCenter />
    </main>
  )
}
