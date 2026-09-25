/** Presents compact static Practice, Test, and Written answer screens for review. */

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

/** Lists the practice-related screens available in the preview navigator. */
export const practiceScenes = [
  { id: "practice-home", label: "Practice home" },
  { id: "practice-question", label: "Practice question" },
  { id: "practice-feedback", label: "Practice feedback" },
  { id: "test-setup", label: "Test setup" },
  { id: "test-question", label: "Test question" },
  { id: "test-results", label: "Test results" },
  { id: "write-prompt", label: "Written answer" },
  { id: "write-comparison", label: "Answer comparison" },
] as const

/** Renders the selected hardcoded practice screen without loading project data. */
export function PracticeMockup({ scene }: { scene: string }) {
  switch (scene) {
    case "practice-question":
      return <SessionScreen mode="practice" />
    case "practice-feedback":
      return <SessionScreen mode="feedback" />
    case "test-setup":
      return <TestSetup />
    case "test-question":
      return <SessionScreen mode="test" />
    case "test-results":
      return <TestResults />
    case "write-prompt":
      return <WrittenAnswer />
    case "write-comparison":
      return <AnswerComparison />
    case "practice-home":
    default:
      return <PracticeHome />
  }
}

/** Frames the screens with a small exit affordance and responsive content width. */
function PracticeFrame({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <main className="min-h-[min(760px,85svh)] bg-background px-4 py-4 text-foreground sm:px-8 sm:py-6">
      <header className="mx-auto flex max-w-4xl items-center justify-between border-b border-border pb-3">
        <p className="text-sm font-medium">{title}</p>
        <Button variant="ghost" size="sm">
          Exit
        </Button>
      </header>
      <div className="mx-auto w-full max-w-4xl py-6 sm:py-8">{children}</div>
    </main>
  )
}

/** Offers the three project practice activities without a duplicate progress panel. */
function PracticeHome() {
  return (
    <PracticeFrame title="Practice">
      <div className="grid gap-3 sm:grid-cols-3">
        <PracticeOption label="Practice questions" />
        <PracticeOption label="Take a test" />
        <PracticeOption label="Written answers" />
      </div>
    </PracticeFrame>
  )
}

/** Presents one practice mode as a single box and action. */
function PracticeOption({ label }: { label: string }) {
  return (
    <Button
      variant="outline"
      className="h-28 w-full flex-col items-stretch justify-between rounded-xl border-border bg-card p-4 text-left text-base hover:bg-muted"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="self-end text-xl">
        →
      </span>
    </Button>
  )
}

/** Shows either immediate practice feedback or a test question with deferred scoring. */
function SessionScreen({ mode }: { mode: "practice" | "feedback" | "test" }) {
  const feedbackVisible = mode === "feedback"
  const testMode = mode === "test"
  return (
    <PracticeFrame title={testMode ? "Test" : "Practice"}>
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>Question 3 of {testMode ? "10" : "12"}</span>
          {testMode ? <span>Results at the end</span> : null}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[30%] rounded-full bg-brand" />
        </div>
        <h1 className="mt-8 font-heading text-[clamp(1.8rem,5vw,2.5rem)] leading-tight font-medium tracking-tight">
          What makes a language model useful for a specific task?
        </h1>
        <div className="mt-5 space-y-2">
          <AnswerOption text="Training on one exact answer." />
          <AnswerOption
            text="A prompt with context and a goal."
            selected={!testMode}
            correct={feedbackVisible}
          />
          <AnswerOption text="Always retrieving a verified source." />
        </div>
        {feedbackVisible ? (
          <p
            className="mt-4 text-sm leading-relaxed text-muted-foreground"
            role="status"
          >
            Correct. A prompt can provide instructions, context, and a response
            format.
          </p>
        ) : null}
        <div className="mt-6 flex justify-end">
          <Button>
            {feedbackVisible
              ? "Next question"
              : testMode
                ? "Next question"
                : "Check answer"}
          </Button>
        </div>
      </div>
    </PracticeFrame>
  )
}

/** Renders a static answer row with selected and correct states when needed. */
function AnswerOption({
  text,
  selected = false,
  correct = false,
}: {
  text: string
  selected?: boolean
  correct?: boolean
}) {
  return (
    <div
      className={`flex min-h-12 items-center rounded-xl border px-4 py-3 text-sm leading-relaxed ${correct ? "border-emerald-500/60 bg-emerald-500/10" : selected ? "border-brand/70 bg-brand/10" : "border-border bg-card"}`}
    >
      {text}
    </div>
  )
}

/** Summarizes test length and opens the end-scored question flow. */
function TestSetup() {
  return (
    <PracticeFrame title="Test">
      <div className="mx-auto max-w-2xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          10 questions
        </h1>
        <Button className="mt-6">Start test</Button>
      </div>
    </PracticeFrame>
  )
}

/** Shows the test score, answer outcomes, and one path to revisit weak concepts. */
function TestResults() {
  return (
    <PracticeFrame title="Test results">
      <div className="mx-auto max-w-2xl">
        <h1 className="font-heading text-3xl font-medium tracking-tight">
          7 of 10
        </h1>
        <div className="mt-6">
          <ResultRow
            number="1"
            prompt="What makes a language model useful for a task?"
            result="Correct"
          />
          <ResultRow
            number="2"
            prompt="What is one limit of retrieval?"
            result="Revisit this concept"
          />
          <ResultRow
            number="3"
            prompt="How can you check a generated claim?"
            result="Incorrect"
          />
        </div>
        <Button className="mt-6">Practice missed concepts</Button>
      </div>
    </PracticeFrame>
  )
}

/** Shows a writing prompt, short draft, and the action to compare it with a guide. */
function WrittenAnswer() {
  return (
    <PracticeFrame title="Write">
      <div className="mx-auto max-w-2xl">
        <p className="text-xs text-muted-foreground">
          Prompt 2 of 5 · Draft saved
        </p>
        <h1 className="mt-4 font-heading text-2xl font-medium tracking-tight sm:text-3xl">
          How can retrieval help a model answer with current information?
        </h1>
        <label
          className="mt-6 block text-sm font-medium"
          htmlFor="answer-draft"
        >
          Your answer
        </label>
        <Textarea
          id="answer-draft"
          className="mt-2 min-h-40 rounded-xl bg-card p-4 text-sm leading-relaxed"
          readOnly
          value="Retrieval adds relevant passages to the prompt for context…"
        />
        <Button className="mt-5">Compare answer</Button>
      </div>
    </PracticeFrame>
  )
}

/** Compares a learner draft with source guidance and advances to the next prompt. */
function AnswerComparison() {
  return (
    <PracticeFrame title="Write">
      <div className="mx-auto max-w-3xl">
        <h1 className="max-w-2xl font-heading text-2xl font-medium tracking-tight">
          How can retrieval help a model answer with current information?
        </h1>
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          <ComparisonPanel title="Your answer">
            Retrieval adds relevant passages to the prompt as context.
          </ComparisonPanel>
          <ComparisonPanel title="Source guide">
            Search finds relevant passages, then provides them to the model
            before it responds. Check the answer against the source.
          </ComparisonPanel>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Intro to LLMs · pages 18–19
        </p>
        <Button className="mt-5">Next prompt</Button>
      </div>
    </PracticeFrame>
  )
}

/** Displays one side of the written answer comparison. */
function ComparisonPanel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed">{children}</p>
      </CardContent>
    </Card>
  )
}

/** Renders one compact question outcome in the test summary. */
function ResultRow({
  number,
  prompt,
  result,
}: {
  number: string
  prompt: string
  result: string
}) {
  return (
    <article className="flex flex-col gap-1 border-b border-border py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className="text-xs text-muted-foreground">{number}</span>
        <h2 className="text-sm font-medium">{prompt}</h2>
      </div>
      <span className="pl-6 text-xs text-muted-foreground sm:shrink-0 sm:pl-0">
        {result}
      </span>
    </article>
  )
}
