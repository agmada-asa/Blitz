/** Presents the three project level ways to practice real study material. */

import Link from "next/link"

import { ArrowLeftIcon, ArrowRightIcon } from "@/components/ui/icon"
import { Button } from "@/components/ui/button"

/** Renders distinct question, test, and writing choices for a project and topic. */
export default async function PracticePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>
  searchParams: Promise<{ topicId?: string }>
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams])
  const projectPath = `/projects/${encodeURIComponent(projectId)}`
  const topicQuery = query.topicId
    ? `?topicId=${encodeURIComponent(query.topicId)}`
    : ""

  return (
    <main className="min-h-svh bg-background px-4 py-6 text-foreground sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="border-b border-border pb-4">
          <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
            <Link href={projectPath}>
              <ArrowLeftIcon aria-hidden="true" /> Back to project
            </Link>
          </Button>
          <h1 className="font-heading text-2xl font-medium tracking-tight">
            Practice
          </h1>
        </header>
        <nav
          aria-label="Practice activities"
          className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <ActivityCard
            label="Questions"
            detail="Feedback after each answer"
            href={`${projectPath}/practice/questions${topicQuery}`}
          />
          <ActivityCard
            label="Test"
            detail="Results when you finish"
            href={`${projectPath}/test${topicQuery}`}
          />
          <ActivityCard
            label="Write"
            detail="Compare your answer with sources"
            href={`${projectPath}/write${topicQuery}`}
          />
        </nav>
      </div>
    </main>
  )
}

/** Shows one activity and links to its existing project-backed workflow. */
function ActivityCard({
  label,
  detail,
  href,
}: {
  label: string
  detail: string
  href: string
}) {
  return (
    <Button
      asChild
      variant="outline"
      className="h-28 w-full flex-col items-stretch justify-between rounded-xl border-border bg-card p-4 text-left text-base whitespace-normal hover:bg-muted sm:h-32"
    >
      <Link href={href}>
        <span className="flex flex-col gap-1">
          <span>{label}</span>
          <span className="text-sm text-muted-foreground">{detail}</span>
        </span>
        <ArrowRightIcon
          aria-hidden="true"
          className="self-end text-muted-foreground"
        />
      </Link>
    </Button>
  )
}
