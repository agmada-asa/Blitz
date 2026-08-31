"use client"

import type { FunctionArgs, FunctionReturnType } from "convex/server"
import {
  ClipboardPaste,
  FileText,
  FileUp,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react"
import { useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { extractSource, type SourceKind } from "@/lib/client/extract-source"
import type { Generation } from "@/lib/server/generate-schema"

type Props = {
  projectId: Id<"projects">
  createSource: (
    input: FunctionArgs<typeof api.sources.createSource>
  ) => Promise<FunctionReturnType<typeof api.sources.createSource>>
  updateSource: (
    input: FunctionArgs<typeof api.sources.updateSource>
  ) => Promise<FunctionReturnType<typeof api.sources.updateSource>>
  insertCards: (
    input: FunctionArgs<typeof api.cards.batchInsertCards>
  ) => Promise<FunctionReturnType<typeof api.cards.batchInsertCards>>
}

type GenerateResponse = Generation | { error: string }
const MAX_GENERATION_CHARACTERS = 120_000

export function SourceUploader({
  projectId,
  createSource,
  updateSource,
  insertCards,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [paste, setPaste] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{
    type: "error" | "success"
    text: string
  }>()
  const [filename, setFilename] = useState("")

  const processSource = async (
    name: string,
    kind: SourceKind,
    text: string
  ) => {
    if (!text.trim()) {
      setMessage({
        type: "error",
        text: "There was no readable text in that source.",
      })
      return
    }
    if (text.length > MAX_GENERATION_CHARACTERS) {
      setMessage({
        type: "error",
        text: "That source is too large for this prototype. Split it into a smaller section first.",
      })
      return
    }

    setBusy(true)
    setMessage(undefined)
    let sourceId: Id<"sources"> | undefined

    try {
      const createdSourceId = await createSource({
        projectId,
        filename: name,
        kind,
        extractedText: text,
      })
      sourceId = createdSourceId
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name, text }),
      })
      const result = (await response.json()) as GenerateResponse

      if (!response.ok || "error" in result) {
        throw new Error(
          "error" in result
            ? result.error
            : "Generation failed. Please try again."
        )
      }

      await insertCards({
        projectId,
        cards: result.cards.map((card, order) => ({
          ...card,
          sourceId: createdSourceId,
          order,
        })),
      })
      await updateSource({ sourceId, summary: result.summary, status: "ready" })
      setMessage({
        type: "success",
        text: `Generated ${result.cards.length} learning cards.`,
      })
      setPaste("")
      setFilename("")
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Generation failed"
      if (sourceId) {
        await updateSource({
          sourceId,
          status: "failed",
          error: errorMessage,
        }).catch(() => undefined)
      }
      setMessage({ type: "error", text: errorMessage })
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async (file?: File) => {
    if (!file) return
    setFilename(file.name)
    try {
      const source = await extractSource(file)
      await processSource(source.filename, source.kind, source.text)
    } catch (error) {
      setMessage({
        type: "error",
        text:
          error instanceof Error ? error.message : "Could not read that file.",
      })
    }
  }

  return (
    <Card
      id="add-source"
      className="scroll-mt-6 overflow-visible border-transparent bg-card"
    >
      <CardContent className="p-5 sm:p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-[#ffd60a] text-black">
            <Sparkles size={26} />
          </div>
          <div>
            <h2 className="font-heading text-xl">Add a source</h2>
            <p className="text-sm text-muted-foreground">
              Paste notes or upload a PDF, Markdown, or text file.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="group flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-5 text-center transition-colors hover:border-[#e6be00] hover:bg-[#ffd60a]/5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:hover:border-[#ffd60a]"
          >
            <FileUp
              className="mb-3 text-muted-foreground group-hover:text-[#c7a400] dark:group-hover:text-[#ffd60a]"
              size={36}
            />
            <span className="font-medium">Upload a file</span>
            <span className="mt-1 text-xs text-muted-foreground">
              PDF · MD · TXT
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.md,.markdown,.txt,text/plain,text/markdown,application/pdf"
              className="hidden"
              onChange={(event) => void chooseFile(event.target.files?.[0])}
            />
          </button>

          <div className="flex min-h-40 flex-col">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <ClipboardPaste size={18} /> Paste notes
            </div>
            <Textarea
              value={paste}
              disabled={busy}
              onChange={(event) => setPaste(event.target.value)}
              placeholder="Drop your notes here…"
              className="min-h-28 flex-1 resize-none"
            />
            <Button
              disabled={busy || !paste.trim()}
              onClick={() => void processSource("Pasted notes", "paste", paste)}
              className="mt-2 w-full"
            >
              {busy ? (
                <>
                  <LoaderCircle
                    className="animate-spin motion-reduce:animate-none"
                    size={16}
                  />{" "}
                  Working…
                </>
              ) : (
                <>
                  Generate cards <Sparkles size={16} />
                </>
              )}
            </Button>
          </div>
        </div>

        {filename && !busy ? (
          <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <FileText size={14} /> {filename}
            <button
              type="button"
              onClick={() => setFilename("")}
              aria-label="Clear selected file"
            >
              <X size={14} />
            </button>
          </p>
        ) : null}

        {message ? (
          <p
            aria-live="polite"
            className={`mt-4 rounded-lg px-3 py-2 text-sm ${
              message.type === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-[#ffd60a]/15 text-foreground"
            }`}
          >
            {message.text}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
