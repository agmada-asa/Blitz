/** Static contextual chat scenes for reviewing the project overhaul direction. */

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"

/** Named chat mockup states shown in the project overhaul preview. */
export const chatScenes = [
  { id: "project-chat", label: "Project chat" },
  { id: "lesson-chat", label: "Lesson question" },
  { id: "chat-sources", label: "Source answer" },
  { id: "chat-options", label: "Chat options" },
] as const

/** Renders one static chat mockup with its project or learning context visible. */
export function ChatMockup({ scene }: { scene: string }) {
  const lesson = scene === "lesson-chat"
  const sources = scene === "chat-sources"
  const options = scene === "chat-options"
  const mobile = lesson

  return (
    <section
      aria-label={mobile ? "Full screen lesson question" : "Project chat"}
      className={`flex min-h-[520px] flex-col overflow-hidden border border-border bg-background text-foreground ${
        mobile
          ? "mx-auto min-h-[620px] w-full max-w-[360px] rounded-[2rem] shadow-sm"
          : "w-full rounded-xl"
      }`}
    >
      <header className="flex min-h-14 items-center gap-2 border-b px-3 py-2 sm:px-4">
        {mobile ? (
          <Button variant="ghost" size="sm" className="shrink-0 px-2">
            ← Lesson
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {lesson ? "Ask about this card" : "Ask Blitz"}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 px-2"
          aria-label="Chat options"
        >
          ⋯
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6">
        <span className="w-fit rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {lesson ? "Transformer attention" : "Intro to LLMs 2"}
        </span>
        <div className="ml-auto max-w-[88%] rounded-2xl rounded-br-sm bg-secondary px-4 py-3 text-sm leading-5">
          {lesson
            ? "Why use multiple attention heads?"
            : "What does attention do?"}
        </div>
        <div className="max-w-[95%] space-y-2 text-sm leading-5">
          <p>
            It lets each token focus on relevant parts of the sequence. Multiple
            heads capture different relationships at once.
          </p>
          {sources ? (
            <Button variant="link" className="h-auto p-0 text-xs">
              Source · Attention is computed in parallel · p. 12
            </Button>
          ) : null}
        </div>
        {options ? (
          <details open className="rounded-lg border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">Options</summary>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-2 text-xs text-muted-foreground">
              <span>Project sources</span>
              <div className="flex items-center gap-2">
                <Checkbox id="mock-chat-citations" defaultChecked />
                <label htmlFor="mock-chat-citations">Citations</label>
              </div>
            </div>
          </details>
        ) : null}
      </div>

      <footer className="border-t bg-background p-3 sm:p-4">
        <div className="flex items-end gap-2 rounded-xl border bg-card p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            aria-label="Message Blitz"
            placeholder="Ask a question…"
            rows={1}
            className="max-h-24 min-h-10 resize-none border-0 px-2 py-2 shadow-none focus-visible:ring-0"
          />
          <Button aria-label="Send message" className="size-10 shrink-0 px-0">
            ↑
          </Button>
        </div>
      </footer>
    </section>
  )
}
