/**
 * @file ocean-app/src/screens/library.tsx
 * @description The Library and a module's learning path. The Library lists every module with its
 * Teach progress; a module lists its units with what has been taught and practised, and each unit
 * opens its Teach session in Blitz or takes new notes and links (`add_material`, the same tool
 * Ocean's agents use).
 */

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { callTool, openLink, setContext } from "../bridge"
import {
  go,
  teachUrl,
  useTool,
  type Home,
  type ModuleDetail,
  type SourceItem,
} from "../data"
import { Bar, List, Row, ScreenHeader, Section, Sheet, Status } from "../ui"

/**
 * Describes a module's progress for its Library row.
 *
 * @param item The module from `app_home`.
 * @returns For example "1 of 3 units finished · next: Week 2".
 */
function moduleDetail(item: Home["modules"][number]): string {
  if (!item.units)
    return item.unsorted
      ? "Sources not grouped into units yet"
      : "No material yet"
  const finished = `${item.finished} of ${item.units} unit${item.units === 1 ? "" : "s"} finished`
  return item.next ? `${finished} · next: ${item.next}` : finished
}

/**
 * New module: a title, created with `create_module`, then opened.
 *
 * @param props.onClose Closes the sheet.
 */
function NewModuleSheet({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = React.useState("")
  const [state, setState] = React.useState<"idle" | "saving" | string>("idle")

  /** Creates the module and goes back to the Library, where it now appears. */
  const create = async () => {
    setState("saving")
    try {
      await callTool("create_module", { title: title.trim() })
      onClose()
    } catch (error) {
      setState(
        error instanceof Error ? error.message : "Blitz couldn't create it."
      )
    }
  }

  return (
    <Sheet title="New module" onClose={onClose}>
      <Input
        autoFocus
        className="mt-4 h-10"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="E.g. Software Engineering"
        aria-label="Module title"
      />
      {state !== "idle" && state !== "saving" ? (
        <p className="mt-2 text-[13px] text-destructive">{state}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          disabled={!title.trim() || state === "saving"}
          onClick={create}
        >
          {state === "saving" ? "Creating…" : "Create module"}
        </Button>
      </div>
    </Sheet>
  )
}

/** Every module, most recently studied first. */
export function Library() {
  const home = useTool<Home>("app_home")
  const [creating, setCreating] = React.useState(false)
  const modules = home.data?.modules ?? []

  React.useEffect(() => {
    setContext("Blitz's Library (every module and its progress).")
  }, [])

  return (
    <>
      <ScreenHeader
        title="Library"
        action={
          <Button variant="outline" size="lg" onClick={() => setCreating(true)}>
            New module
          </Button>
        }
      />
      {modules.length ? (
        <List>
          {modules.map((item) => (
            <Row
              key={item.id}
              title={item.title}
              meta={
                item.units ? `${Math.round(item.progress * 100)}%` : undefined
              }
              detail={moduleDetail(item)}
              progress={item.units ? item.progress : undefined}
              onOpen={() => go("module", item.id)}
            />
          ))}
        </List>
      ) : (
        <Status
          loading={home.loading}
          error={home.error}
          empty="No modules yet. Create one, then add its material."
          onRetry={home.reload}
        />
      )}
      {creating ? <NewModuleSheet onClose={() => setCreating(false)} /> : null}
    </>
  )
}

/**
 * Add material to a unit: written notes and/or public links, through `add_material`. Files
 * stay on the Mac, so they're added there (or by asking Ocean).
 *
 * @param props.module Module id.
 * @param props.unit The unit's title, or null for a new unit named in the sheet.
 * @param props.onClose Closes the sheet.
 */
function AddMaterialSheet({
  module,
  unit,
  onClose,
}: {
  module: string
  unit: string | null
  onClose: () => void
}) {
  const [title, setTitle] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [link, setLink] = React.useState("")
  const [state, setState] = React.useState<
    "idle" | "saving" | { result: string } | { error: string }
  >("idle")
  const unitTitle = unit ?? title.trim()
  const ready =
    Boolean(unitTitle) &&
    Boolean(notes.trim() || link.trim()) &&
    state !== "saving"

  /** Adds the notes and link, then shows Blitz's report of each item. */
  const add = async () => {
    setState("saving")
    try {
      const result = await callTool<string>("add_material", {
        module,
        unit: unitTitle,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(link.trim() ? { links: [link.trim()] } : {}),
      })
      setState({ result: String(result) })
    } catch (error) {
      setState({
        error:
          error instanceof Error ? error.message : "Blitz couldn't add it.",
      })
    }
  }

  return (
    <Sheet
      title={unit ? `Add to ${unit}` : "New unit"}
      detail="Notes and public links. Files on your Mac can be added there, or ask Ocean."
      onClose={onClose}
    >
      {typeof state === "object" && "result" in state ? (
        <p className="mt-4 text-[14px] whitespace-pre-line">{state.result}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {unit ? null : (
            <Input
              autoFocus
              className="h-10"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Unit title, e.g. Week 4: Normalisation"
              aria-label="Unit title"
            />
          )}
          <Textarea
            className="min-h-28"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Notes to teach from"
            aria-label="Notes"
          />
          <Input
            className="h-10"
            type="url"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https:// link to slides, a PDF or a page"
            aria-label="Link"
          />
        </div>
      )}
      {typeof state === "object" && "error" in state ? (
        <p className="mt-2 text-[13px] text-destructive">{state.error}</p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="lg" onClick={onClose}>
          {typeof state === "object" && "result" in state ? "Done" : "Cancel"}
        </Button>
        {typeof state === "object" && "result" in state ? null : (
          <Button size="lg" disabled={!ready} onClick={add}>
            {state === "saving" ? "Adding…" : "Add material"}
          </Button>
        )}
      </div>
    </Sheet>
  )
}

/**
 * The sources in a unit or a module's other groups.
 *
 * @param props.sources Sources to list.
 */
function Sources({ sources }: { sources: SourceItem[] }) {
  return (
    <ul className="mt-2 space-y-1">
      {sources.map((source) => (
        <li
          key={source.id}
          className="truncate text-[13px] text-muted-foreground"
        >
          {source.name}
          {source.unreadable
            ? " · can't be read"
            : source.status !== "ready"
              ? ` · ${source.status}`
              : ""}
        </li>
      ))}
    </ul>
  )
}

/**
 * Practice for a unit, from the questions it has answered.
 *
 * @param unit The unit from `app_module`.
 * @returns For example "12 questions, 9 of 10 answered right"; empty without questions.
 */
function practiceLine(unit: ModuleDetail["units"][number]): string {
  if (!unit.questions) return ""
  const questions = `${unit.questions} question${unit.questions === 1 ? "" : "s"}`
  return unit.answered
    ? `${questions}, ${unit.correct} of ${unit.answered} answered right`
    : questions
}

/**
 * One module: practice to do, then its units in path order. Tapping a unit shows its sources
 * and actions.
 *
 * @param props.id Module id.
 */
export function ModuleScreen({ id }: { id: string }) {
  const detail = useTool<ModuleDetail>("app_module", { module: id })
  const [open, setOpen] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<{ unit: string | null } | null>(
    null
  )
  const data = detail.data

  React.useEffect(() => {
    if (data)
      setContext(
        `the Blitz module "${data.title}" (module id ${data.id}), with units: ${data.units.map((unit) => `"${unit.title}" (${unit.taught}% taught)`).join(", ") || "none yet"}.`
      )
  }, [data])

  if (!data)
    return (
      <>
        <ScreenHeader title="Module" back />
        <Status
          loading={detail.loading}
          error={detail.error}
          onRetry={detail.reload}
        />
      </>
    )

  const { practice } = data
  const practised = data.units.some((unit) => unit.questions)

  return (
    <>
      <ScreenHeader
        title={data.title}
        back
        detail={`${data.units.length} unit${data.units.length === 1 ? "" : "s"}`}
      />

      {practised ? (
        <section className="mx-5 mb-2 rounded-2xl border border-border bg-card p-4">
          <p className="text-[15px] font-semibold">
            {practice.due
              ? `${practice.due} concept${practice.due === 1 ? "" : "s"} due`
              : practice.missed
                ? `${practice.missed} question${practice.missed === 1 ? "" : "s"} to retry`
                : "Nothing due here"}
          </p>
          {practice.weak.length ? (
            <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
              Not sticking yet:{" "}
              {practice.weak.map((concept) => concept.title).join(", ")}
            </p>
          ) : null}
          <Button
            size="lg"
            className="mt-3 px-4"
            variant={practice.due || practice.missed ? "default" : "outline"}
            onClick={() => go("review", data.id)}
          >
            Review this module
          </Button>
        </section>
      ) : null}

      <Section title="Units">
        {data.units.length ? (
          <ul className="divide-y divide-border">
            {data.units.map((unit) => {
              const expanded = open === unit.id
              const practiceText = practiceLine(unit)
              return (
                <li key={unit.id}>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : unit.id)}
                    className="block w-full px-5 py-3 text-left transition-colors active:bg-muted"
                  >
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 text-[15px] leading-snug font-medium">
                        {unit.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {unit.taught}%
                      </span>
                    </span>
                    <span className="mt-0.5 block text-[13px] text-muted-foreground">
                      {[
                        unit.section
                          ? `Now on ${unit.section}`
                          : unit.taught === 100
                            ? "Taught"
                            : unit.started
                              ? "Started"
                              : "Not started",
                        practiceText,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <Bar value={unit.taught / 100} />
                  </button>
                  {expanded ? (
                    <div className="px-5 pb-4">
                      {unit.sources.length ? (
                        <Sources sources={unit.sources} />
                      ) : (
                        <p className="text-[13px] text-muted-foreground">
                          No sources yet.
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="lg"
                          className="bg-brand px-4 text-brand-foreground hover:bg-brand/85"
                          disabled={!unit.sources.length}
                          onClick={() =>
                            openLink(teachUrl(data.links, data.id, unit.id))
                          }
                        >
                          {unit.started
                            ? "Continue in Blitz"
                            : "Teach in Blitz"}
                        </Button>
                        {unit.questions ? (
                          <Button
                            size="lg"
                            variant="outline"
                            className="px-4"
                            onClick={() => go("review", data.id)}
                          >
                            Review
                          </Button>
                        ) : null}
                        <Button
                          size="lg"
                          variant="outline"
                          className="px-4"
                          onClick={() => setAdding({ unit: unit.title })}
                        >
                          Add material
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-5 py-2 text-[14px] text-muted-foreground">
            No units yet.
          </p>
        )}
        <div className="px-5 pt-2">
          <Button
            variant="outline"
            size="lg"
            onClick={() => setAdding({ unit: null })}
          >
            New unit
          </Button>
        </div>
      </Section>

      {data.unsorted.length ? (
        <Section title="Not in a unit yet">
          <div className="px-5">
            <Sources sources={data.unsorted} />
          </div>
        </Section>
      ) : null}
      {data.references.length ? (
        <Section title="Reference books">
          <div className="px-5">
            <Sources sources={data.references} />
          </div>
        </Section>
      ) : null}

      {adding ? (
        <AddMaterialSheet
          module={data.id}
          unit={adding.unit}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </>
  )
}
