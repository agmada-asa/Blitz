"use client"

/** Renders provider approvals, questions, forms, and URL handoffs above the chat composer. */

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  parseAgentRequestInput,
  type AgentRequest,
  type AgentRequestField,
  type AgentRequestQuestion,
  type AgentRequestSubmission,
} from "@/lib/agent-request"
import { cn } from "@/lib/utils"

/** Props needed to resolve one provider request from the composer. */
type AgentRequestPanelProps = {
  /** Request currently blocking the active assistant turn. */
  request: AgentRequest
  /** Whether the server is saving the current response. */
  busy?: boolean
  /** Receives a validated browser submission for the request. */
  onSubmit: (submission: AgentRequestSubmission) => void
}

/** Returns a compact remaining-time label for a request's five-minute lease. */
function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")} left`
}

/** Returns whether a form value contains a useful answer for a required field. */
function hasValue(value: unknown): boolean {
  return Boolean(
    (typeof value === "string" && value.trim()) ||
    (Array.isArray(value) && value.length) ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

/** Renders one agent question with either a choice list or a typed answer. */
function QuestionControl({
  question,
  answer,
  otherValue,
  disabled,
  onChange,
  onOtherChange,
}: {
  question: AgentRequestQuestion
  answer?: string
  otherValue?: string
  disabled: boolean
  onChange: (value: string) => void
  onOtherChange: (value: string) => void
}) {
  const options = question.options ?? []
  const hasChoices = options.length > 0 || question.isOther
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-foreground">
        {question.question}
      </legend>
      {question.header !== question.question ? (
        <p className="text-xs text-muted-foreground">{question.header}</p>
      ) : null}
      {hasChoices ? (
        <div className="space-y-1.5">
          {options.map((option) => {
            const value = option.value ?? option.label
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50",
                  answer === value && "border-brand/50 bg-brand/5",
                  disabled && "cursor-not-allowed opacity-60"
                )}
              >
                <input
                  type="radio"
                  name={`agent-request-${question.id}`}
                  value={value}
                  checked={answer === value}
                  disabled={disabled}
                  className="mt-0.5 size-4 accent-[var(--brand)]"
                  onChange={() => onChange(value)}
                />
                <span className="min-w-0 text-sm">
                  <span className="block text-foreground">{option.label}</span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </label>
            )
          })}
          {question.isOther ? (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50",
                answer === "__other__" && "border-brand/50 bg-brand/5",
                disabled && "cursor-not-allowed opacity-60"
              )}
            >
              <input
                type="radio"
                name={`agent-request-${question.id}`}
                value="__other__"
                checked={answer === "__other__"}
                disabled={disabled}
                className="mt-0.5 size-4 accent-[var(--brand)]"
                onChange={() => onChange("__other__")}
              />
              <span className="min-w-0 flex-1 text-sm text-foreground">
                Other
                {answer === "__other__" ? (
                  <Input
                    autoFocus
                    type={question.isSecret ? "password" : "text"}
                    value={otherValue ?? ""}
                    disabled={disabled}
                    placeholder="Type your answer"
                    className="mt-2"
                    onChange={(event) => onOtherChange(event.target.value)}
                  />
                ) : null}
              </span>
            </label>
          ) : null}
        </div>
      ) : (
        <Input
          type={question.isSecret ? "password" : "text"}
          value={answer ?? ""}
          disabled={disabled}
          aria-label={question.header}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </fieldset>
  )
}

/** Renders one MCP form field with the smallest native control that fits its type. */
function FormFieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: AgentRequestField
  value: unknown
  disabled: boolean
  onChange: (value: unknown) => void
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-sm text-foreground">
        <Checkbox
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <span className="leading-5">{field.label}</span>
      </label>
    )
  }
  if (field.type === "single-select") {
    return (
      <select
        aria-label={field.label}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select an option</option>
        {(field.options ?? []).map((option) => (
          <option
            key={option.value ?? option.label}
            value={option.value ?? option.label}
          >
            {option.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === "multi-select") {
    const selected = Array.isArray(value) ? value : []
    return (
      <div className="space-y-1.5">
        {(field.options ?? []).map((option) => {
          const optionValue = option.value ?? option.label
          return (
            <label
              key={optionValue}
              className="flex items-start gap-2 text-sm text-foreground"
            >
              <Checkbox
                checked={selected.includes(optionValue)}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected, optionValue]
                      : selected.filter((item) => item !== optionValue)
                  )
                }
              />
              <span className="leading-5">{option.label}</span>
            </label>
          )
        })}
      </div>
    )
  }
  return (
    <Input
      type={
        field.type === "number" || field.type === "integer"
          ? "number"
          : field.secret
            ? "password"
            : "text"
      }
      step={field.type === "integer" ? 1 : undefined}
      value={
        typeof value === "string" || typeof value === "number" ? value : ""
      }
      disabled={disabled}
      aria-label={field.label}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Renders one composer-anchored request and serializes the user's answer for the server. */
export function AgentRequestPanel({
  request,
  busy = false,
  onSubmit,
}: AgentRequestPanelProps) {
  const input = useMemo(
    () => parseAgentRequestInput(request.input),
    [request.input]
  )
  const [now, setNow] = useState(() => Date.now())
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({})
  const [freeform, setFreeform] = useState("")
  const expired = request.expiresAt <= now
  const questions = useMemo(() => input.questions ?? [], [input.questions])
  const fields = useMemo(() => input.fields ?? [], [input.fields])
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.id,
        field.defaultValue ??
          (field.type === "boolean"
            ? false
            : field.type === "multi-select"
              ? []
              : ""),
      ])
    )
  )

  useEffect(() => {
    if (request.status !== "pending") return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [request.status])

  /** Resolves a question answer, replacing the sentinel with the typed Other value. */
  const submitQuestions = (): void => {
    const resolvedAnswers = Object.fromEntries(
      questions.map((question) => [
        question.id,
        {
          answers: [
            answers[question.id] === "__other__"
              ? (otherAnswers[question.id] ?? "")
              : (answers[question.id] ?? ""),
          ],
        },
      ])
    )
    onSubmit({
      decision: "approved",
      response: JSON.stringify({ answers: resolvedAnswers }),
    })
  }

  /** Serializes MCP field values using the response shape expected by Codex. */
  const submitForm = (): void => {
    const content = Object.fromEntries(
      fields.map((field) => {
        const value = formValues[field.id]
        if (field.type === "number")
          return [field.id, value === "" ? undefined : Number(value)]
        if (field.type === "integer")
          return [field.id, value === "" ? undefined : Number(value)]
        return [field.id, value]
      })
    )
    if (!fields.length && freeform.trim()) content.response = freeform.trim()
    onSubmit({
      decision: "approved",
      response: JSON.stringify({ action: "accept", content }),
    })
  }

  const questionsReady = questions.every((question) => {
    const answer = answers[question.id]
    return Boolean(
      answer && (answer !== "__other__" || otherAnswers[question.id]?.trim())
    )
  })
  const formReady = fields.every(
    (field) => !field.required || hasValue(formValues[field.id])
  )
  const isConfirmation =
    request.kind === "approval" && request.method === "item/tool/call"
  const submitLabel =
    request.kind === "approval"
      ? isConfirmation
        ? "Confirm"
        : "Allow once"
      : request.kind === "question"
        ? "Send answers"
        : request.kind === "url"
          ? "I’m finished"
          : "Submit"

  return (
    <section
      aria-label={`Blitz request: ${request.title}`}
      className="mb-2 rounded-2xl border border-brand/30 bg-brand/5 p-3 shadow-sm sm:p-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {request.title}
          </h2>
          {request.prompt ? (
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {request.prompt}
            </p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 text-xs text-muted-foreground tabular-nums",
            expired && "text-destructive"
          )}
        >
          {expired ? "Expired" : remainingLabel(request.expiresAt, now)}
        </span>
      </div>

      {request.kind === "approval" && request.details !== request.prompt ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
          {request.details}
        </pre>
      ) : null}

      {request.kind === "question" ? (
        <div className="mt-2 space-y-4">
          {questions.map((question) => (
            <QuestionControl
              key={question.id}
              question={question}
              answer={answers[question.id]}
              otherValue={otherAnswers[question.id]}
              disabled={busy || expired}
              onChange={(value) =>
                setAnswers((current) => ({ ...current, [question.id]: value }))
              }
              onOtherChange={(value) =>
                setOtherAnswers((current) => ({
                  ...current,
                  [question.id]: value,
                }))
              }
            />
          ))}
        </div>
      ) : null}

      {request.kind === "form" ? (
        <div className="mt-2 space-y-3">
          {fields.length ? (
            fields.map((field) => (
              <div key={field.id} className="space-y-1.5">
                {field.type !== "boolean" ? (
                  <label className="text-sm font-medium text-foreground">
                    {field.label}
                    {field.required ? <span aria-hidden="true"> *</span> : null}
                  </label>
                ) : null}
                {field.description ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    {field.description}
                  </p>
                ) : null}
                <FormFieldControl
                  field={field}
                  value={formValues[field.id]}
                  disabled={busy || expired}
                  onChange={(value) =>
                    setFormValues((current) => ({
                      ...current,
                      [field.id]: value,
                    }))
                  }
                />
              </div>
            ))
          ) : (
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor={`agent-request-${request.id}`}
              >
                Response
              </label>
              <Textarea
                id={`agent-request-${request.id}`}
                value={freeform}
                disabled={busy || expired}
                rows={3}
                placeholder="Add the information Blitz needs"
                onChange={(event) => setFreeform(event.target.value)}
              />
            </div>
          )}
        </div>
      ) : null}

      {request.kind === "url" && input.url ? (
        <div className="mt-2 rounded-lg border border-border/70 bg-background/70 p-3">
          <a
            href={input.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-brand underline underline-offset-4 hover:text-brand/80 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Open the requested page
          </a>
          <p className="mt-1 text-xs break-all text-muted-foreground">
            {input.url}
          </p>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            busy ||
            expired ||
            (request.kind === "question" && !questionsReady) ||
            (request.kind === "form" && !formReady)
          }
          onClick={() => {
            if (request.kind === "question") submitQuestions()
            else if (request.kind === "form") submitForm()
            else onSubmit({ decision: "approved" })
          }}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || expired}
          onClick={() => onSubmit({ decision: "denied" })}
        >
          {request.kind === "approval" ? "Deny" : "Cancel"}
        </Button>
      </div>
    </section>
  )
}
