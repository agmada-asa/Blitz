/** Presents static Listen destination mockups for the project overhaul preview. */

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** Named Listen screens available in the project overhaul preview. */
export const listenScenes = [
  { id: "listen-home", label: "Listen library" },
  { id: "listen-audiobook", label: "Create audiobook" },
  { id: "listen-podcast", label: "Create podcast" },
  { id: "listen-processing", label: "Creating audio" },
  { id: "listening-room", label: "Listening room" },
  { id: "audio-ask", label: "Ask about audio" },
] as const

/** Renders a compact title for a static Listen scene. */
function ListenHeader({ detail }: { detail: string }) {
  return (
    <header className="border-b border-border/70 pb-4">
      <h2 className="font-heading text-xl font-medium tracking-tight sm:text-2xl">
        {detail}
      </h2>
    </header>
  )
}

/** Shows recording titles, types, durations, and one resume action. */
function ListenLibrary() {
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
        <h2 className="font-heading text-xl font-medium tracking-tight sm:text-2xl">
          Listen
        </h2>
        <Button type="button" variant="outline" size="sm" className="min-h-9">
          Create recording
        </Button>
      </header>
      <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
        <li className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">
              Introduction to language models
            </h3>
            <p className="text-xs text-muted-foreground">Audiobook · 28 min</p>
          </div>
          <Button type="button" className="min-h-9 w-full sm:w-auto">
            Resume listening
          </Button>
        </li>
        <li className="flex min-w-0 flex-col gap-1 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">
              How language models learn
            </h3>
            <p className="text-xs text-muted-foreground">Podcast · 15 min</p>
          </div>
        </li>
      </ul>
    </div>
  )
}

/** Shows one focused audiobook or podcast setup screen. */
function ListenCreate({ mode }: { mode: "audiobook" | "podcast" }) {
  const isAudiobook = mode === "audiobook"

  return (
    <div className="space-y-5">
      <ListenHeader
        detail={
          isAudiobook ? "Create an audiobook" : "Create a project podcast"
        }
      />
      <Card className="w-full max-w-2xl">
        <CardContent className="space-y-4">
          {isAudiobook ? (
            <div className="space-y-1.5 text-sm">
              <label htmlFor="mock-audiobook-source" className="font-medium">
                Source
              </label>
              <Select defaultValue="llm-foundations">
                <SelectTrigger id="mock-audiobook-source" className="h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="llm-foundations">
                    LLM foundations.pdf
                  </SelectItem>
                  <SelectItem value="course-notes">Course notes.md</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div className="space-y-1.5 text-sm">
                <label htmlFor="mock-episode-length" className="font-medium">
                  Episode length
                </label>
                <Select defaultValue="15">
                  <SelectTrigger id="mock-episode-length" className="h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Focus</span>
                <Textarea
                  aria-label="Focus"
                  className="min-h-20 resize-none"
                  readOnly
                  value="Training and inference"
                />
              </label>
            </>
          )}
          <Button type="button" variant="default" className="min-h-10 w-full">
            {isAudiobook ? "Create audiobook" : "Create podcast"}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/** Explains a generation stage with its progress and a clear return action. */
function ListenProcessing() {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <ListenHeader detail="Creating your podcast" />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>How language models learn</CardTitle>
            </div>
            <Badge variant="secondary">In progress</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            role="progressbar"
            aria-label="Audio creation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={67}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full w-2/3 rounded-full bg-brand" />
          </div>
          <ol className="space-y-3 text-sm">
            <li className="flex items-center gap-3">
              <span className="text-brand" aria-hidden="true">
                ✓
              </span>
              <span>Preparing project sources</span>
              <span className="ml-auto text-xs text-muted-foreground">
                Done
              </span>
            </li>
            <li className="flex items-center gap-3 font-medium">
              <span className="text-brand" aria-hidden="true">
                ●
              </span>
              <span>Writing the episode</span>
              <span className="ml-auto text-xs text-muted-foreground">
                In progress
              </span>
            </li>
            <li className="flex items-center gap-3 text-muted-foreground">
              <span aria-hidden="true">○</span>
              <span>Creating the audio</span>
              <span className="ml-auto text-xs">Up next</span>
            </li>
          </ol>
          <Button type="button" variant="outline" className="min-h-10">
            Back to Listen
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/** Shows the audio controls and chapter list in a focused listening view. */
function ListeningRoom() {
  return (
    <div className="space-y-5">
      <ListenHeader detail="Introduction to language models" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card className="h-fit lg:sticky lg:top-5">
          <CardContent className="space-y-4">
            <div className="flex items-center gap-1" aria-hidden="true">
              {Array.from({ length: 28 }, (_, index) => (
                <span
                  key={index}
                  className={`h-7 flex-1 rounded-sm ${index < 11 ? "bg-brand/80" : "bg-muted"}`}
                />
              ))}
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>11:24</span>
              <span>28:06</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-[41%] rounded-full bg-brand" />
            </div>
            <div className="flex items-center justify-center gap-4 pt-1">
              <Button
                type="button"
                className="size-12 rounded-full text-lg"
                aria-label="Play audio"
              >
                ▶
              </Button>
            </div>
          </CardContent>
        </Card>

        <section
          aria-labelledby="transcript-title"
          className="min-w-0 space-y-3"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3
                id="transcript-title"
                className="font-heading text-lg font-medium"
              >
                Transcript
              </h3>
            </div>
          </div>
          <div className="space-y-3">
            <ol className="divide-y divide-border/70 rounded-lg border border-border/70">
              <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
                <span>Introduction</span>
                <span className="text-xs text-muted-foreground">
                  00:00–06:18
                </span>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 bg-muted/50 px-3 py-3 text-sm font-medium">
                <span>Training and tokens</span>
                <span className="text-xs text-muted-foreground">
                  06:18–13:42
                </span>
              </li>
              <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-3 text-sm">
                <span>From prompt to response</span>
                <span className="text-xs text-muted-foreground">
                  13:42–20:05
                </span>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </div>
  )
}

/** Carries a selected transcript passage into one contextual question. */
function AudioAsk() {
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <ListenHeader detail="Ask about this passage" />
      <Card className="border-brand/30 bg-muted/30">
        <CardHeader className="pb-0">
          <p className="text-xs text-muted-foreground">
            LLM foundations.pdf · 08:42
          </p>
          <p className="mt-2 text-sm text-foreground">
            “During training, the model adjusts its internal parameters to make
            better predictions across many examples. The patterns it learns can
            then help it respond to new prompts.”
          </p>
        </CardHeader>
      </Card>
      <div className="space-y-3">
        <Textarea
          aria-label="Your question"
          className="min-h-24 max-w-3xl resize-none bg-card"
          readOnly
          value="What does “adjusts its parameters” mean here?"
        />
        <Button type="button" className="min-h-10">
          Ask Blitz
        </Button>
      </div>
    </div>
  )
}

/** Selects one static Listen scene and provides a safe fallback for unknown IDs. */
export function ListenMockup({ scene }: { scene: string }) {
  const content =
    scene === "listen-audiobook" ? (
      <ListenCreate mode="audiobook" />
    ) : scene === "listen-podcast" ? (
      <ListenCreate mode="podcast" />
    ) : scene === "listen-processing" ? (
      <ListenProcessing />
    ) : scene === "listening-room" ? (
      <ListeningRoom />
    ) : scene === "audio-ask" ? (
      <AudioAsk />
    ) : (
      <ListenLibrary />
    )

  return (
    <main className="mx-auto w-full max-w-5xl space-y-5 px-4 py-5 sm:px-6 sm:py-7">
      {content}
    </main>
  )
}
