/** Keeps old activity links working after the route became Notifications. */

import { redirect } from "next/navigation"

/** Redirects the former Activity route to the notification center. */
export default function ActivityPage() {
  redirect("/notifications")
}
