/** Provides concise static project home states for the redesign preview. */

import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ArrowRightIcon,
  CheckCircleIcon,
  FileIcon,
  LoadingIcon,
} from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"

/** Lists the home and project lifecycle states available in the preview. */
export const homeScenes = [
  { id: "overview", label: "Overview" },
  { id: "empty", label: "Empty project" },
  { id: "processing", label: "Preparing" },
  { id: "project-actions", label: "Project actions" },
  { id: "project-rename", label: "Rename project" },
  { id: "project-delete", label: "Delete confirmation" },
] as const

/** Shows one static home state from the preview scene selector. */
export function HomeMockup({ scene }: { scene: string }) {
  if (scene === "empty") return <EmptyProject />
  if (scene === "processing") return <PreparingProject />
  if (scene === "project-actions") return <ProjectActionsMockup />
  if (scene === "project-rename") return <RenameProjectMockup />
  if (scene === "project-delete") return <DeleteProjectMockup />
  return <ProjectOverview />
}

/** Shows one resume action, four destinations, and compact sample progress. */
function ProjectOverview() {
  return (
    <ProjectFrame>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          Intro to LLMs
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" className="min-h-10 rounded-full">
            Ask Blitz
          </Button>
          <Button variant="outline" className="min-h-10 rounded-full">
            Project actions
          </Button>
        </div>
      </header>

      <Card className="mt-8 border-brand/25 bg-brand/[0.04]">
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div>
            <p className="text-xs text-muted-foreground">
              Lesson 4 · Foundations
            </p>
            <h2 className="mt-1 font-heading text-lg font-semibold">
              Tokens and context windows
            </h2>
          </div>
          <Button className="min-h-11 w-full rounded-full sm:w-auto">
            Resume learning <ArrowRightIcon aria-hidden="true" />
          </Button>
        </CardContent>
      </Card>

      <section
        aria-label="Project areas"
        className="mt-8 grid grid-cols-2 gap-3 xl:grid-cols-4"
      >
        <DestinationTile title="Learn" />
        <DestinationTile title="Practice" />
        <DestinationTile title="Sources" />
        <DestinationTile title="Listen" />
      </section>

      <section
        aria-label="Sample project progress"
        className="mt-8 flex items-center gap-4"
      >
        <span className="shrink-0 text-sm text-muted-foreground">
          6 / 17 lessons
        </span>
        <Progress value={35} aria-label="Sample progress: 6 of 17 lessons" />
      </section>
    </ProjectFrame>
  )
}

/** Renders one project destination as a single, uncluttered box. */
function DestinationTile({ title }: { title: string }) {
  return (
    <Button
      variant="outline"
      className="h-28 w-full flex-col items-stretch justify-between rounded-xl border-border bg-card p-4 text-left text-base hover:bg-muted"
    >
      <span>{title}</span>
      <ArrowRightIcon aria-hidden="true" className="self-end" />
    </Button>
  )
}

/** Shows the single next action for a project without sources. */
function EmptyProject() {
  return (
    <ProjectFrame>
      <ProjectHeading title="New project" />
      <Card className="mx-auto mt-10 max-w-lg">
        <CardContent className="flex flex-col items-center px-6 py-12 text-center">
          <FileIcon className="size-7 text-brand" aria-hidden="true" />
          <Button className="mt-5 min-h-11 w-full rounded-full sm:w-auto">
            Add a source
          </Button>
        </CardContent>
      </Card>
    </ProjectFrame>
  )
}

/** Shows source preparation with the active step made clear. */
function PreparingProject() {
  return (
    <ProjectFrame>
      <ProjectHeading title="Intro to LLMs" />
      <Card className="mt-8 max-w-2xl">
        <CardHeader>
          <CardTitle>Preparing study material</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-3 rounded-lg bg-muted/60 p-3">
            <FileIcon
              className="size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="min-w-0 flex-1 truncate text-sm font-medium">
              LLM course notes.pdf
            </p>
            <LoadingIcon
              className="size-4 shrink-0 animate-spin text-brand"
              aria-label="In progress"
            />
          </div>
          <div className="space-y-3" aria-label="Preparation steps">
            <PreparationStep title="Source uploaded" complete />
            <PreparationStep title="Reading source" complete />
            <PreparationStep title="Creating learning path" active />
            <PreparationStep title="Creating practice" />
          </div>
        </CardContent>
      </Card>
    </ProjectFrame>
  )
}

/** Renders a preparation step as complete, active, or upcoming. */
function PreparationStep({
  title,
  complete = false,
  active = false,
}: {
  title: string
  complete?: boolean
  active?: boolean
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className={
          complete
            ? "text-emerald-500"
            : active
              ? "text-brand"
              : "text-muted-foreground"
        }
      >
        {complete ? (
          <CheckCircleIcon size={18} aria-hidden="true" />
        ) : active ? (
          <LoadingIcon size={18} aria-hidden="true" />
        ) : (
          <span
            className="block size-[18px] rounded-full border border-border"
            aria-hidden="true"
          />
        )}
      </span>
      <span className={active ? "font-medium" : "text-muted-foreground"}>
        {title}
      </span>
    </div>
  )
}

/** Shows the project action menu open above its project name. */
function ProjectActionsMockup() {
  return (
    <ProjectFrame>
      <div className="flex items-center justify-between gap-4">
        <ProjectHeading title="Intro to LLMs" />
        <DropdownMenu open>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-h-10 rounded-full">
              Project actions
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem>Rename project</DropdownMenuItem>
            <DropdownMenuItem className="text-destructive">
              Delete project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </ProjectFrame>
  )
}

/** Shows the rename dialog over the project page. */
function RenameProjectMockup() {
  return (
    <ProjectFrame>
      <ProjectHeading title="Intro to LLMs" />
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <label className="text-sm font-medium" htmlFor="mock-project-name">
            Project name
          </label>
          <Input
            id="mock-project-name"
            value="Intro to LLMs"
            readOnly
            className="-mt-2 h-11"
          />
          <DialogFooter>
            <Button variant="outline" className="min-h-10 rounded-full">
              Cancel
            </Button>
            <Button disabled className="min-h-10 rounded-full">
              Save name
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProjectFrame>
  )
}

/** Shows a concise destructive confirmation naming the project and its contents. */
function DeleteProjectMockup() {
  return (
    <ProjectFrame>
      <ProjectHeading title="Intro to LLMs" />
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “Intro to LLMs”?</DialogTitle>
            <DialogDescription>
              Removes this project, its sources, study content, conversations,
              and history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-10 rounded-full">
              Cancel
            </Button>
            <Button variant="destructive" className="min-h-10 rounded-full">
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProjectFrame>
  )
}

/** Provides responsive page width and gutters for each mockup state. */
function ProjectFrame({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
      {children}
    </main>
  )
}

/** Renders a concise title for project home states. */
function ProjectHeading({ title }: { title: string }) {
  return (
    <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
      {title}
    </h1>
  )
}
