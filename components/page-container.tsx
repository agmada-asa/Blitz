/**
 * The one content column every browse page sits in: the Library, project
 * pages, Notifications and Settings. Sharing it keeps titles, crumbs and
 * actions at the same position as the learner moves between pages, rather
 * than each page picking its own width and padding. Full-screen modes such
 * as Teach, exams, drills, Review and Chat keep their own focused layouts.
 */

import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * Width and padding of the browse page column. The extra bottom padding on
 * phones clears the bottom navigation bar.
 */
export const PAGE_CONTAINER_CLASS =
  "mx-auto w-full max-w-5xl px-5 py-10 pb-28 sm:px-8 sm:py-14"

/**
 * Renders a page's `<main>` landmark in the shared browse column. Extra
 * classes add to the column, for example spacing between sections.
 */
export function PageContainer({ className, ...props }: ComponentProps<"main">) {
  return <main className={cn(PAGE_CONTAINER_CLASS, className)} {...props} />
}
