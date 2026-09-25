"use client"

/** Lets learners browse saved concepts, relationships, and their source evidence. */

import Link from "next/link"
import { useMemo, useState } from "react"
import { useQuery } from "convex/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ArrowLeftIcon, ArrowRightIcon, FileIcon } from "@/components/ui/icon"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { ConceptRelationKind } from "@/lib/concept-map"

/** URL identity and optional linked concept for this view. */
type Props = { projectId: string; selectedConceptId?: string }

/** Returns the visible direction of one typed connection from the selected concept. */
function relationshipLabel(
  kind: ConceptRelationKind,
  selectedIsFrom: boolean
): string {
  switch (kind) {
    case "prerequisite_for":
      return selectedIsFrom ? "Needed before" : "Builds on"
    case "part_of":
      return selectedIsFrom ? "Part of" : "Includes"
    case "causes":
      return selectedIsFrom ? "Can cause" : "Can result from"
    case "contrasts_with":
      return "Contrasts with"
    case "applies_to":
      return selectedIsFrom ? "Applies to" : "Uses"
    case "related_to":
      return "Related to"
  }
}

/** Renders a topic-grouped concept directory beside the selected concept's links. */
export function ProjectConceptMap({ projectId, selectedConceptId }: Props) {
  const projectIdValue = projectId as Id<"projects">
  const project = useQuery(api.projects.getProject, {
    projectId: projectIdValue,
  })
  const map = useQuery(api.conceptMap.getProjectMap, {
    projectId: projectIdValue,
  })
  const [search, setSearch] = useState("")
  const base = `/projects/${encodeURIComponent(projectId)}`
  const concepts = useMemo(
    () =>
      [...(map?.concepts ?? [])].sort(
        (a, b) =>
          a.topicTitle.localeCompare(b.topicTitle) ||
          a.title.localeCompare(b.title)
      ),
    [map]
  )
  const selected =
    concepts.find((concept) => String(concept.id) === selectedConceptId) ??
    concepts[0]
  const filtered = concepts.filter((concept) =>
    [concept.title, concept.topicTitle, ...concept.aliases].some((value) =>
      value.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    )
  )
  const sources = new Map(
    map?.sources.map((source) => [String(source.id), source.filename]) ?? []
  )
  const conceptById = new Map(
    concepts.map((concept) => [String(concept.id), concept])
  )
  const links = (map?.relationships ?? [])
    .filter(
      (relationship) =>
        selected &&
        (relationship.fromConceptId === selected.id ||
          relationship.toConceptId === selected.id)
    )
    .flatMap((relationship) => {
      const selectedIsFrom = relationship.fromConceptId === selected?.id
      const other = conceptById.get(
        String(
          selectedIsFrom ? relationship.toConceptId : relationship.fromConceptId
        )
      )
      return other ? [{ ...relationship, selectedIsFrom, other }] : []
    })
    .sort(
      (a, b) =>
        a.other.title.localeCompare(b.other.title) ||
        a.kind.localeCompare(b.kind)
    )

  if (project === undefined || map === undefined) {
    return (
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-8 sm:px-7">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-80 w-full" />
      </main>
    )
  }
  if (!project || !map) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-12 sm:px-7">
        <h1 className="font-heading text-2xl font-semibold">
          Project not found
        </h1>
        <Button asChild variant="outline" className="mt-5">
          <Link href="/library">Back to library</Link>
        </Button>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-5 pb-24 sm:px-7 sm:py-8">
      <Button asChild variant="ghost" size="sm" className="mb-3 -ml-2">
        <Link href={base}>
          <ArrowLeftIcon aria-hidden="true" />
          {project.title}
        </Link>
      </Button>
      <header className="mb-7 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            Concept map
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Explore ideas from your sources and the connections between them.
          </p>
        </div>
        <Badge variant="outline">
          {concepts.length} {concepts.length === 1 ? "concept" : "concepts"}
        </Badge>
      </header>

      {!concepts.length ? (
        <Card>
          <CardContent className="p-6">
            <h2 className="font-heading text-lg font-semibold">
              No concepts yet
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Add a source to start building the map.
            </p>
            <Button asChild className="mt-5">
              <Link href={`${base}/sources`}>Add sources</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)]">
          <Card className="min-w-0">
            <CardContent className="p-4 sm:p-5">
              <label htmlFor="concept-search" className="text-sm font-medium">
                Find a concept
              </label>
              <Input
                id="concept-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search concepts"
                className="mt-2"
              />
              <nav
                aria-label="Concepts"
                className="mt-4 max-h-[34rem] space-y-4 overflow-y-auto pr-1"
              >
                {filtered.length ? (
                  filtered.map((concept, index) => {
                    const previous = filtered[index - 1]
                    return (
                      <div key={String(concept.id)}>
                        {previous?.topicTitle !== concept.topicTitle ? (
                          <h2 className="mb-1 px-2 text-sm font-medium text-muted-foreground">
                            {concept.topicTitle}
                          </h2>
                        ) : null}
                        <Button
                          asChild
                          variant={
                            selected?.id === concept.id ? "secondary" : "ghost"
                          }
                          className="h-auto min-h-10 w-full justify-start text-left whitespace-normal"
                        >
                          <Link
                            href={`${base}/map?concept=${encodeURIComponent(String(concept.id))}`}
                            aria-current={
                              selected?.id === concept.id ? "page" : undefined
                            }
                          >
                            {concept.title}
                          </Link>
                        </Button>
                      </div>
                    )
                  })
                ) : (
                  <p className="px-2 py-3 text-sm text-muted-foreground">
                    No matching concepts.
                  </p>
                )}
              </nav>
            </CardContent>
          </Card>

          {selected ? (
            <Card className="min-w-0">
              <CardContent className="p-5 sm:p-7">
                <Badge
                  variant="secondary"
                  className="h-auto max-w-full py-1 text-left break-words whitespace-normal"
                >
                  {selected.topicTitle}
                </Badge>
                <h2 className="mt-3 font-heading text-2xl font-semibold break-words">
                  {selected.title}
                </h2>
                {selected.aliases.length ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Also called {selected.aliases.join(", ")}
                  </p>
                ) : null}
                <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                  {selected.sourceIds.map((sourceId) => (
                    <Link
                      key={String(sourceId)}
                      href={`${base}/sources/${encodeURIComponent(String(sourceId))}`}
                      className="inline-flex max-w-full min-w-0 items-center gap-1.5 break-all text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <FileIcon size={15} aria-hidden="true" />
                      {sources.get(String(sourceId)) ?? "Source"}
                    </Link>
                  ))}
                </div>
                <div className="mt-8 border-t border-border pt-6">
                  <h3 className="font-heading text-lg font-semibold">
                    Connections
                  </h3>
                  {!links.length ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      No connections recorded for this concept yet.
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-border">
                      {links.map((link) => (
                        <li key={String(link.id)} className="py-4 first:pt-0">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-xs font-medium text-muted-foreground">
                              {relationshipLabel(
                                link.kind,
                                link.selectedIsFrom
                              )}
                            </span>
                            <Link
                              href={`${base}/map?concept=${encodeURIComponent(String(link.other.id))}`}
                              className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 hover:text-brand focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              {link.other.title}
                              <ArrowRightIcon size={14} aria-hidden="true" />
                            </Link>
                          </div>
                          <p className="mt-2 text-sm leading-6">
                            {link.explanation}
                          </p>
                          <p className="mt-2 text-xs text-muted-foreground">
                            <Link
                              href={`${base}/sources/${encodeURIComponent(String(link.sourceId))}`}
                              className="underline decoration-border underline-offset-4 hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              {link.sourceFilename}
                            </Link>
                            {link.evidence.length
                              ? `, ${link.evidence.map((item) => item.locator).join("; ")}`
                              : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </main>
  )
}
