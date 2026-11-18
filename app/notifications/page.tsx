/** Presents ongoing work and recent results in one notification center. */

import { NotificationCenter } from "@/components/notifications/notification-center"
import { PageContainer } from "@/components/page-container"

/** Renders the notification center route. */
export default function NotificationsPage() {
  return (
    <PageContainer>
      <div className="mb-5">
        <h1 className="font-heading text-2xl font-medium tracking-tight sm:text-3xl">
          Notifications
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          Practice questions, exam papers, marking, research and AI replies.
        </p>
      </div>
      <NotificationCenter />
    </PageContainer>
  )
}
