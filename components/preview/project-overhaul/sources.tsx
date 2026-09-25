/** Static Sources mockups for the project overhaul preview. */

import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  AiSearch01Icon,
  ArrowLeftIcon,
  ArrowRightIcon,
  FileIcon,
  FileUploadIconComponent,
  LinkIcon,
  RefreshIcon,
} from "@/components/ui/icon"

/** Checkpoints shown in the project overhaul preview navigator. */
export const sourceScenes = [
  { id: "sources-home", label: "Sources" },
  { id: "source-upload", label: "Upload a file" },
  { id: "source-paste", label: "Paste notes" },
  { id: "source-link", label: "Import a link" },
  { id: "source-processing", label: "Source processing" },
  { id: "source-error", label: "Source error" },
  { id: "source-detail", label: "Source overview" },
  { id: "source-pdf", label: "PDF preview" },
  { id: "source-text", label: "Extracted text" },
  { id: "source-find", label: "Find sources" },
  { id: "source-results", label: "Suggested sources" },
] as const

/** Wraps each fixture in the current Blitz project navigation styling. */
function ProjectFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[580px] rounded-2xl border border-border bg-background text-foreground shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <span className="truncate text-sm font-medium">Intro to LLMs</span>
        <nav
          aria-label="Project sections"
          className="flex max-w-full gap-1 overflow-x-auto text-sm"
        >
          {["Overview", "Learn", "Practice", "Sources", "Listen"].map(
            (name) => (
              <span
                key={name}
                className={`rounded-md px-3 py-2 whitespace-nowrap ${name === "Sources" ? "bg-secondary font-medium" : "text-muted-foreground"}`}
              >
                {name}
              </span>
            )
          )}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-7 sm:py-7">
        {children}
      </main>
    </div>
  )
}

/** Displays a source with a wrapping filename, status, and open action. */
function SourceRow({
  name,
  status,
  tone = "secondary",
}: {
  name: string
  status: string
  tone?: "secondary" | "outline" | "destructive"
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <FileIcon size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
        <p className="min-w-0 text-sm font-medium break-words">{name}</p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <Badge variant={tone}>{status}</Badge>
        <Button variant="outline" size="sm">
          Open
        </Button>
      </div>
    </div>
  )
}

/** Selects a static Sources screen by its preview scene ID. */
export function SourcesMockup({ scene }: { scene: string }) {
  if (scene === "source-upload") return <AddSourceScene tab="upload" />
  if (scene === "source-paste") return <AddSourceScene tab="notes" />
  if (scene === "source-link") return <AddSourceScene tab="link" />
  if (scene === "source-processing") return <ProcessingScene />
  if (scene === "source-error") return <SourceErrorScene />
  if (scene === "source-detail") return <SourceDetailScene />
  if (scene === "source-pdf") return <PdfScene />
  if (scene === "source-text") return <TextScene />
  if (scene === "source-find") return <FindSourcesScene />
  if (scene === "source-results") return <SuggestedSourcesScene />
  return <SourcesHomeScene />
}

/** Shows the source list and its main add action. */
function SourcesHomeScene() {
  return (
    <ProjectFrame>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-2xl font-semibold">Sources</h1>
        <Button>
          <FileUploadIconComponent size={16} className="mr-2" />
          Add source
        </Button>
      </div>
      <div className="divide-y divide-border rounded-xl border border-border bg-card px-4">
        <SourceRow
          name="A practical introduction to large language models.pdf"
          status="Ready"
        />
        <SourceRow
          name="Retrieval augmented generation: a survey of methods and evaluation.md"
          status="Ready"
        />
        <SourceRow
          name="Lecture 04 — Attention and transformers.pdf"
          status="Preparing"
          tone="outline"
        />
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline">Find sources</Button>
        <span className="text-sm text-muted-foreground">
          1 source preparing
        </span>
      </div>
    </ProjectFrame>
  )
}

/** Shows file upload, notes, or link input with only field labels and actions. */
function AddSourceScene({
  tab = "upload",
}: {
  tab?: "upload" | "notes" | "link"
}) {
  return (
    <ProjectFrame>
      <h1 className="mb-5 font-heading text-2xl font-semibold">Add a source</h1>
      <Tabs defaultValue={tab} className="max-w-3xl">
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="notes">Paste notes</TabsTrigger>
          <TabsTrigger value="link">Import link</TabsTrigger>
        </TabsList>
        <TabsContent value="upload" className="mt-4">
          <Card>
            <CardContent className="flex flex-col items-center p-5 text-center sm:p-8">
              <FileUploadIconComponent size={22} className="text-brand" />
              <Button className="mt-4">Choose files</Button>
              <p className="mt-3 text-xs text-muted-foreground">
                PDF, PowerPoint, Markdown, or text
              </p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="notes" className="mt-4">
          <Card>
            <CardContent className="space-y-4 p-4 sm:p-6">
              <label className="block space-y-2 text-sm font-medium">
                Source name
                <Input placeholder="Week 3 lecture notes" />
              </label>
              <label className="block space-y-2 text-sm font-medium">
                Notes
                <Textarea className="min-h-40" />
              </label>
              <div className="flex justify-end">
                <Button>Add notes</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="link" className="mt-4">
          <Card>
            <CardContent className="space-y-4 p-4 sm:p-6">
              <label className="block space-y-2 text-sm font-medium">
                Page link
                <div className="relative">
                  <LinkIcon
                    size={16}
                    className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    className="pl-9"
                    placeholder="https://example.com/article"
                  />
                </div>
              </label>
              <div className="flex justify-end">
                <Button>Preview link</Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
      <div className="mt-4">
        <Button variant="link" className="h-auto px-0">
          Find sources
        </Button>
      </div>
    </ProjectFrame>
  )
}

/** Shows one active preparation state with a single progress indicator. */
function ProcessingScene() {
  return (
    <ProjectFrame>
      <h1 className="mb-5 font-heading text-2xl font-semibold">
        Preparing source
      </h1>
      <Card className="max-w-2xl">
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 text-sm font-medium break-words">
              Lecture 04 — Attention and transformers.pdf
            </p>
            <Badge variant="outline">Preparing</Badge>
          </div>
          <Progress value={48} className="mt-5" />
          <p className="mt-2 text-sm text-muted-foreground">Section 6 of 12</p>
        </CardContent>
      </Card>
    </ProjectFrame>
  )
}

/** Shows one short failure message and the recovery actions. */
function SourceErrorScene() {
  return (
    <ProjectFrame>
      <h1 className="mb-5 font-heading text-2xl font-semibold">Source error</h1>
      <Card className="max-w-2xl border-destructive/40">
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm font-medium break-words">
            Lecture slides — week 2.pdf
          </p>
          <Badge variant="destructive" className="mt-3">
            Couldn’t read this PDF
          </Badge>
          <p className="mt-3 text-sm text-muted-foreground">
            Try an unlocked, text based PDF.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button>
              <RefreshIcon size={15} className="mr-2" aria-hidden="true" />
              Try again
            </Button>
            <Button variant="outline">Open original</Button>
          </div>
        </CardContent>
      </Card>
    </ProjectFrame>
  )
}

/** Shows the source name, summary, access actions, and page provenance. */
function SourceDetailScene() {
  return (
    <ProjectFrame>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2">
        <ArrowLeftIcon size={15} className="mr-2" />
        Sources
      </Button>
      <div className="max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 font-heading text-xl font-semibold break-words sm:text-2xl">
            A practical introduction to large language models.pdf
          </h1>
          <Badge variant="secondary">Ready</Badge>
        </div>
        <p className="mt-5 text-sm leading-6">
          Introduction to language models, tokenization, transformer
          architecture, and training objectives.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button>Open PDF</Button>
          <Button variant="outline">Extracted text</Button>
        </div>
        <div className="mt-7 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
          <span className="font-medium">Transformer attention</span>
          <Badge variant="outline">Pages 12–14</Badge>
          <Button variant="link" className="ml-auto h-auto px-0">
            Open card
          </Button>
        </div>
      </div>
    </ProjectFrame>
  )
}

/** Shows a compact static PDF page with simple page navigation. */
function PdfScene() {
  return (
    <ProjectFrame>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2">
        <ArrowLeftIcon size={15} className="mr-2" />
        Source
      </Button>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-sm font-medium break-words">
          A practical introduction to large language models.pdf
        </h1>
        <Button variant="outline" size="sm">
          Download
        </Button>
      </div>
      <div className="rounded-xl border border-border bg-secondary/40 p-3 sm:p-6">
        <article className="mx-auto min-h-[390px] max-w-2xl rounded-sm border border-border bg-white p-6 text-neutral-800 sm:p-10">
          <h2 className="text-xl font-semibold">
            A practical introduction to large language models
          </h2>
          <p className="mt-5 text-sm leading-7">
            Large language models learn patterns in text by predicting which
            token is likely to come next. Transformer models use attention to
            relate each token to other parts of a sequence.
          </p>
        </article>
        <div className="mx-auto mt-3 flex max-w-2xl items-center justify-between text-sm">
          <Button variant="ghost" size="sm">
            <ArrowLeftIcon size={15} />
            Previous
          </Button>
          <span className="text-muted-foreground">Page 1 of 35</span>
          <Button variant="ghost" size="sm">
            Next
            <ArrowRightIcon size={15} className="ml-1" />
          </Button>
        </div>
      </div>
    </ProjectFrame>
  )
}

/** Shows extracted document text with a find input. */
function TextScene() {
  return (
    <ProjectFrame>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2">
        <ArrowLeftIcon size={15} className="mr-2" />
        Source
      </Button>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="min-w-0 text-sm font-medium break-words">
          A practical introduction to large language models.pdf
        </h1>
        <label className="relative w-full sm:w-56">
          <span className="sr-only">Find in text</span>
          <AiSearch01Icon
            size={15}
            className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input className="pl-9" placeholder="Find in text" />
        </label>
      </div>
      <article className="max-w-3xl rounded-xl border border-border bg-card p-5 text-sm leading-7 sm:p-7">
        <h2 className="font-medium">Introduction</h2>
        <p className="mt-3 text-muted-foreground">
          Large language models are trained to predict and generate sequences of
          language. They learn statistical relationships between tokens from a
          large collection of text.
        </p>
        <h2 className="mt-6 font-medium">How models learn</h2>
        <p className="mt-3 text-muted-foreground">
          During pretraining, a model learns to predict a missing or subsequent
          token. Instruction tuning can make a model more useful for following
          requests.
        </p>
        <p className="mt-5 text-xs text-muted-foreground">Page 1 of 35</p>
      </article>
    </ProjectFrame>
  )
}

/** Provides one topic field and the research action. */
function FindSourcesScene() {
  return (
    <ProjectFrame>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2">
        <ArrowLeftIcon size={15} className="mr-2" />
        Sources
      </Button>
      <div className="max-w-2xl">
        <h1 className="mb-5 font-heading text-2xl font-semibold">
          Find sources
        </h1>
        <label className="block space-y-2 text-sm font-medium">
          Topic
          <Textarea
            className="min-h-36"
            placeholder="e.g. How attention works in transformer models"
          />
        </label>
        <Button className="mt-4">Find sources</Button>
      </div>
    </ProjectFrame>
  )
}

/** Shows concise research results with selection and one import action. */
function SuggestedSourcesScene() {
  const results = [
    {
      id: "attention-paper",
      title: "Attention Is All You Need",
      origin: "arxiv.org",
      checked: true,
    },
    {
      id: "illustrated-transformer",
      title: "The Illustrated Transformer",
      origin: "jalammar.github.io",
      checked: true,
    },
    {
      id: "attention-survey",
      title: "A Survey of Attention Mechanisms in Deep Learning",
      origin: "arxiv.org",
      checked: false,
    },
  ]
  return (
    <ProjectFrame>
      <Button variant="ghost" size="sm" className="mb-4 -ml-2">
        <ArrowLeftIcon size={15} className="mr-2" />
        Edit search
      </Button>
      <h1 className="mb-5 font-heading text-2xl font-semibold">
        Suggested sources
      </h1>
      <div className="max-w-3xl divide-y divide-border rounded-xl border border-border bg-card px-4">
        {results.map((result) => (
          <div
            key={result.title}
            className="flex min-w-0 items-start gap-3 py-4"
          >
            <Checkbox
              id={result.id}
              defaultChecked={result.checked}
              aria-label={`Select ${result.title}`}
              className="mt-0.5"
            />
            <label
              htmlFor={result.id}
              className="min-w-0 flex-1 cursor-pointer"
            >
              <span className="block text-sm font-medium break-words">
                {result.title}
              </span>
              <span className="mt-1 block text-xs break-all text-muted-foreground">
                {result.origin}
              </span>
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
            >
              Preview
            </Button>
          </div>
        ))}
      </div>
      <Button className="mt-5">Add 2 sources</Button>
    </ProjectFrame>
  )
}
