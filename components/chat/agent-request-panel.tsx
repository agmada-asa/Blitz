"use client"

/** Renders provider approvals, questions, forms, and URL handoffs above the chat composer. */

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ChevronRightIcon } from "@/components/ai/provider-icons"
import {
  extractApprovalCommand,
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
  /** Renders a completed interaction as transcript history without controls. */
  readOnly?: boolean
  /** Optional container class overrides. */
  className?: string
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
  answer?: string | string[]
  otherValue?: string
  disabled: boolean
  onChange: (value: string | string[]) => void
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
        question.multiSelect ? (
          <div className="space-y-1.5">
            {options.map((option) => {
              const value = option.value ?? option.label
              const isChecked = Array.isArray(answer) && answer.includes(value)
              const inputId = `agent-request-${question.id}-${value}`
              return (
                <label
                  key={value}
                  htmlFor={inputId}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50",
                    isChecked && "border-brand/50 bg-brand/5",
                    disabled && "cursor-not-allowed opacity-60"
                  )}
                >
                  <Checkbox
                    id={inputId}
                    checked={isChecked}
                    disabled={disabled}
                    className="mt-0.5"
                    onCheckedChange={(checked) => {
                      const current = Array.isArray(answer) ? answer : []
                      onChange(
                        checked
                          ? [...current, value]
                          : current.filter((item) => item !== value)
                      )
                    }}
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
          </div>
        ) : (
          <RadioGroup
            value={typeof answer === "string" ? answer : ""}
            onValueChange={onChange}
            disabled={disabled}
            className="gap-1.5"
          >
            {options.map((option) => {
              const value = option.value ?? option.label
              const isChecked = answer === value
              const inputId = `agent-request-${question.id}-${value}`
              return (
                <label
                  key={value}
                  htmlFor={inputId}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50",
                    isChecked && "border-brand/50 bg-brand/5",
                    disabled && "cursor-not-allowed opacity-60"
                  )}
                >
                  <RadioGroupItem
                    value={value}
                    id={inputId}
                    className="mt-0.5"
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
                htmlFor={`agent-request-${question.id}-__other__`}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-lg border border-border/70 px-3 py-2 transition-colors hover:bg-muted/50",
                  answer === "__other__" && "border-brand/50 bg-brand/5",
                  disabled && "cursor-not-allowed opacity-60"
                )}
              >
                <RadioGroupItem
                  value="__other__"
                  id={`agent-request-${question.id}-__other__`}
                  className="mt-0.5"
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
          </RadioGroup>
        )
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

/** Renders one MCP form field with the shared control that fits its type. */
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
      <Select
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        onValueChange={onChange}
      >
        <SelectTrigger aria-label={field.label} className="w-full">
          <SelectValue placeholder="Select an option" />
        </SelectTrigger>
        <SelectContent>
          {(field.options ?? []).map((option) => (
            <SelectItem
              key={option.value ?? option.label}
              value={option.value ?? option.label}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  readOnly = false,
  className,
  onSubmit,
}: AgentRequestPanelProps) {
  const input = useMemo(
    () => parseAgentRequestInput(request.input),
    [request.input]
  )
  const [now, setNow] = useState(() => Date.now())
  const [answers, setAnswers] = useState<
    Record<string, string | string[]>
  >({})
  const [approvalOption, setApprovalOption] = useState("")
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({})
  const [freeform, setFreeform] = useState("")
  const expired = request.expiresAt <= now
  const questions = useMemo(() => input.questions ?? [], [input.questions])
  const fields = useMemo(() => input.fields ?? [], [input.fields])
  const approvalOptions = useMemo(
    () => input.approvalOptions ?? [],
    [input.approvalOptions]
  )
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
          answers:
            answers[question.id] === "__other__"
              ? [otherAnswers[question.id] ?? ""]
              : Array.isArray(answers[question.id])
                ? answers[question.id]
                : [answers[question.id] ?? ""],
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
    const hasAnswer = Array.isArray(answer) ? answer.length > 0 : Boolean(answer)
    return Boolean(
      hasAnswer &&
        (answer !== "__other__" || otherAnswers[question.id]?.trim())
    )
  })
  const formReady = fields.every(
    (field) => !field.required || hasValue(formValues[field.id])
  )
  if (readOnly) {
    const stateLabel =
      request.status === "approved"
        ? request.kind === "question"
          ? "Answered"
          : "Approved"
        : request.status === "denied"
          ? "Declined"
          : request.status === "expired"
            ? "Expired"
            : request.status === "cancelled"
              ? "Cancelled"
              : "Pending"
    return (
      <section
        aria-label={`Blitz request result: ${request.title}`}
        className={cn(
          "rounded-xl border border-border/70 bg-muted/20 p-3 text-sm",
          className
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-foreground">{request.title}</h3>
          <span className="text-xs text-muted-foreground">{stateLabel}</span>
        </div>
        {request.prompt ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {request.prompt}
          </p>
        ) : null}
        {request.kind === "approval" &&
        request.details &&
        request.details !== request.prompt ? (
          (() => {
            const command = extractApprovalCommand(request.details)
            return (
              <details className="group mt-2">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" />
                  <span>{command ? "View command" : "View details"}</span>
                </summary>
                <div className="mt-2">
                  {command ? (
                    <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2 font-mono text-xs text-foreground select-all">
                      <code>{command}</code>
                    </pre>
                  ) : (
                    <pre className="max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
                      {request.details}
                    </pre>
                  )}
                </div>
              </details>
            )
          })()
        ) : null}
        {input.validationError ? (
          <p className="mt-2 text-xs text-destructive">{input.validationError}</p>
        ) : request.kind === "question" && request.response ? (
          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
            {(() => {
              let parsed: { answers?: Record<string, { answers?: string[] }> } = {}
              try {
                parsed = JSON.parse(request.response) as typeof parsed
              } catch {
                return <p>The submitted answer could not be displayed.</p>
              }
              return questions.map((question) => {
                const selected = parsed.answers?.[question.id]?.answers ?? []
                const labels = selected.map(
                  (value) =>
                    question.options?.find(
                      (option) => (option.value ?? option.label) === value
                    )?.label ?? value
                )
                return (
                  <div key={question.id}>
                    <p className="font-medium text-foreground">{question.question}</p>
                    <p>{labels.length ? `Selected: ${labels.join(", ")}` : "No answer"}</p>
                    {question.options?.length ? (
                      <ul className="mt-1 list-disc pl-4">
                        {question.options.map((option) => {
                          const value = option.value ?? option.label
                          return (
                            <li key={value} className={selected.includes(value) ? "font-medium text-foreground" : undefined}>
                              {option.label}
                              {selected.includes(value) ? " (selected)" : ""}
                            </li>
                          )
                        })}
                      </ul>
                    ) : null}
                  </div>
                )
              })
            })()}
          </div>
        ) : request.kind === "approval" ? (
          (() => {
            try {
              const parsed = request.response
                ? (JSON.parse(request.response) as { optionId?: string })
                : null
              if (parsed?.optionId === "acceptForSession") {
                return (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Allowed for this session
                  </p>
                )
              }
            } catch {
              // Non-JSON responses or parse errors are not displayed for approvals.
            }
            return null
          })()
        ) : request.response ? (
          <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-background/70 p-2 text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
            {request.response}
          </pre>
        ) : null}
      </section>
    )
  }
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
        (() => {
          const command = extractApprovalCommand(request.details)
          return (
            <details className="group mt-2">
              <summary className="flex cursor-pointer select-none items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                <ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-200 group-open:rotate-90" />
                <span>{command ? "View command" : "View details"}</span>
              </summary>
              <div className="mt-2">
                {command ? (
                  <pre className="overflow-x-auto rounded-lg border border-border/70 bg-background/80 px-3 py-2 font-mono text-xs text-foreground select-all">
                    <code>{command}</code>
                  </pre>
                ) : (
                  <pre className="max-h-48 overflow-auto rounded-lg border border-border/70 bg-background/70 px-3 py-2 text-[11px] leading-5 whitespace-pre-wrap text-muted-foreground">
                    {request.details}
                  </pre>
                )}
              </div>
            </details>
          )
        })()
      ) : null}

      {request.kind === "approval" && approvalOptions.length ? (
        <fieldset className="mt-3 space-y-2">
          <legend className="text-xs font-medium text-foreground">
            Choose an option
          </legend>
          <RadioGroup
            value={approvalOption}
            onValueChange={setApprovalOption}
            disabled={busy || expired}
            className="gap-2"
          >
            {approvalOptions.map((option) => {
              const value = option.value ?? option.label
              const optionId = `agent-approval-${request.id}-${value}`
              return (
                <div key={value} className="flex items-center gap-2">
                  <RadioGroupItem value={value} id={optionId} />
                  <label
                    htmlFor={optionId}
                    className="cursor-pointer text-sm font-normal text-foreground"
                  >
                    {option.label}
                  </label>
                </div>
              )
            })}
          </RadioGroup>
        </fieldset>
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
            Boolean(input.validationError) ||
            expired ||
            (request.kind === "question" && !questionsReady) ||
            (request.kind === "form" && !formReady) ||
            (request.kind === "approval" &&
              approvalOptions.length > 0 &&
              !approvalOption)
          }
          onClick={() => {
            if (request.kind === "question") submitQuestions()
            else if (request.kind === "form") submitForm()
            else
              onSubmit({
                decision: "approved",
                ...(approvalOption
                  ? { response: JSON.stringify({ optionId: approvalOption }) }
                  : {}),
              })
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
