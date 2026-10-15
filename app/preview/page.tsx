/** Keeps the shared checkpoint URL working after the live feed replaces its fixtures. */

import { redirect } from "next/navigation"

/** Sends existing preview links to the real source-backed learning feed. */
export default function PreviewPage() {
  redirect("/review")
}
