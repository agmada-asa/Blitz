/** Keeps old `/library` links working now that the Library is the start page. */

import { redirect } from "next/navigation"

/** Redirects to the start page. */
export default function Page() {
  redirect("/")
}
