"use client"

/** Connects a project route to its sources, generation controls, and study action. */

import { useMutation, useQuery } from "convex/react"
import Link from "next/link"
import { use } from "react"

import { SourceUploader } from "@/components/projects/source-uploader"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ArrowLeftIcon,
  BookOpenIcon,
  FileIcon,
  LayersIcon,
} from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"

/** Renders one live project after resolving its Next.js 16 route parameters. */
export default function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = use(params)
  const convexProjectId = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: convexProjectId,
  })
  const sources = useQuery(api.sources.listSources, {
    projectId: convexProjectId,
  })
  const createSource = useMutation(api.sources.createSource)
  const updateSource = useMutation(api.sources.updateSource)
  const insertCards = useMutation(api.cards.batchInsertCards)
  const hasReadySource =
    sources?.some((source) => source.status === "ready") ?? false

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 pb-28 sm:px-8 sm:py-12">
      <Link
        href="/"
        className="mb-10 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon size={16} /> All projects
      </Link>

      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Badge variant="outline" className="mb-3">
            Study project
          </Badge>
          <h1 className="font-heading text-4xl tracking-tight sm:text-6xl">
            {project?.title || "Loading…"}
            <span className="text-muted-foreground">.</span>
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            Build a clear mental model from your own material.
          </p>
        </div>
        {hasReadySource ? (
          <Button asChild size="lg" className="rounded-full">
            <Link href={`/projects/${projectId}/study`}>
              <BookOpenIcon size={18} /> Start studying
            </Link>
          </Button>
        ) : (
          <Button disabled size="lg" className="rounded-full">
            <BookOpenIcon size={18} /> Start studying
          </Button>
        )}
      </div>

      <SourceUploader
        projectId={convexProjectId}
        createSource={createSource}
        updateSource={updateSource}
        insertCards={insertCards}
      />

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-heading text-2xl">Sources</h2>
          <span className="text-sm text-muted-foreground">
            {sources?.length ?? 0} total
          </span>
        </div>
        {!sources?.length ? (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
            <LayersIcon className="mx-auto mb-3" size={32} />
            Your generated summaries will appear here.
          </div>
        ) : (
          <div className="space-y-3">
            {sources.map((source) => (
              <div
                key={source._id}
                className="flex items-center justify-between rounded-xl bg-card p-4 ring-1 ring-foreground/10"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                    <FileIcon size={21} />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{source.filename}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {source.status === "processing"
                        ? "Generating cards…"
                        : source.status === "failed"
                          ? source.error || "Failed"
                          : source.summary || "Ready to study"}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={
                    source.status === "ready"
                      ? "secondary"
                      : source.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {source.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
