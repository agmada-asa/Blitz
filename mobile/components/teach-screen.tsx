/**
 * Teach on the phone: the same live tutor session as the desktop Teach
 * screen, for one unit. It opens (or creates) the unit's session, starts
 * teaching straight away, and shows the lesson as it is written, with the
 * outline as a segmented bar, quick replies, questions to the tutor, and
 * lesson quizzes that count as study evidence.
 *
 * Turns go through the shared `/api/chat` route; while a reply is being
 * written the screen polls `/api/mobile/teach` for the saved text, as the
 * desktop reads it from the database. Every opened lesson is saved on the
 * device, so it can be reread offline; quizzes answered offline are graded
 * from the lesson itself and recorded when the server is back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  gradeQuizAnswer,
  type QuizBlock,
  type StepsBlock,
} from "../../lib/interactive-blocks"
import type { MobileTeachMessage, MobileTeachResponse } from "../../lib/learning/mobile-contracts"
import {
  TEACH_QUICK_REPLIES,
  parseTeachOutline,
  parseTeachSectionMarker,
  type TeachOutline,
} from "../../lib/teach"
import { inlineMathToText } from "../../lib/math-text"
import { MobileApiError } from "../lib/api"
import {
  answerTeachQuiz,
  fetchSummary,
  fetchTeach,
  pauseTeachTurn,
  sendTeachTurn,
  startTeach,
} from "../lib/learning-api"
import { flushTeachAnswers, loadCached, queueTeachAnswer, saveCached } from "../lib/offline-cache"
import { restartSitting, sittingStart } from "../lib/sitting"
import { teachParts } from "../lib/teach-content"
import { brandAlpha, colors, radius, TOUCH_TARGET } from "../lib/theme"
import { Markdown } from "./markdown"
import { Text, TextInput } from "./native-text"
import { PathMarker, SegmentedBar, pathSegments } from "./progress-path"
import { QuestionView } from "./question-view"
import { SessionSummary } from "./session-summary"

/** Props for the Teach screen. */
export type TeachScreenProps = {
  readonly serverUrl: string
  readonly unitId: string
  /** A message to send once the session is ready, such as a Relearn request. */
  readonly initialAsk?: string
  readonly onBack: () => void
  readonly onPractice: (projectId: string, unitId: string) => void
  readonly onOpenUnit: (unitId: string) => void
}

/** How often the saved reply is re-read while the tutor is writing. */
const POLL_MS = 1200

/** Quick replies offered under the lesson, in the desktop's order. */
const QUICK_REPLIES = [
  { label: "Next section", message: TEACH_QUICK_REPLIES.next },
  { label: "Another example", message: TEACH_QUICK_REPLIES.example },
  { label: "Go deeper", message: TEACH_QUICK_REPLIES.deeper },
  { label: "I don't get it", message: TEACH_QUICK_REPLIES.confused },
] as const

/** Short labels for quick replies when they appear in the transcript. */
const QUICK_REPLY_LABELS = new Map<string, string>([
  [TEACH_QUICK_REPLIES.start, "Teach me this unit"],
  ...QUICK_REPLIES.map((reply) => [reply.message, reply.label] as [string, string]),
])

/** Where the learner is in the outline, read from saved progress and the messages. */
function lessonPosition(data: MobileTeachResponse | undefined, outline: TeachOutline | null) {
  const taught = new Set(data?.progress?.taughtSectionIds ?? [])
  let index = Math.max(0, data?.progress?.sectionIndex ?? 0)
  if (!outline) return { sectionIndex: 0, taught }
  // Markers in the messages keep progress live while a reply streams.
  for (const message of data?.messages ?? []) {
    if (message.role !== "assistant") continue
    const marker = parseTeachSectionMarker(message.content)
    if (marker?.kind === "done") index = outline.sections.length
    else if (marker) {
      const found = outline.sections.findIndex((section) => section.id === marker.id)
      if (found >= 0) {
        index = found
        taught.add(marker.id)
      }
    }
  }
  return { sectionIndex: index, taught }
}

/** Renders the Teach screen for one unit. */
export function TeachScreen({ serverUrl, unitId, initialAsk, onBack, onPractice, onOpenUnit }: TeachScreenProps) {
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<MobileTeachResponse>()
  const [offline, setOffline] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [draft, setDraft] = useState("")
  const [localAnswers, setLocalAnswers] = useState<Record<string, string[]>>({})
  const [since, setSince] = useState<number>()
  const [sittingXp, setSittingXp] = useState(0)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const offsets = useRef(new Map<string, number>())
  const revealId = useRef<string | null>(null)
  const restored = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const startingRef = useRef(false)
  const autoStarted = useRef(false)
  const askSent = useRef(false)
  const wasRunning = useRef(false)

  /** Loads the session from the server, falling back to the saved copy. */
  const load = useCallback(async () => {
    try {
      const fresh = await fetchTeach(serverUrl, unitId)
      setData(fresh)
      setOffline(false)
      setLoadError("")
      if (fresh.status !== "running") await saveCached(serverUrl, `teach:${unitId}`, fresh)
      return fresh
    } catch (caught) {
      const cached = await loadCached<MobileTeachResponse>(serverUrl, `teach:${unitId}`)
      if (cached) {
        setData((current) => current ?? cached.value)
        setOffline(true)
      } else setLoadError(caught instanceof Error ? caught.message : "This unit could not be opened.")
      return undefined
    }
  }, [serverUrl, unitId])

  /** Refreshes the XP earned this sitting, shown in the header. */
  const refreshXp = useCallback(
    async (projectId: string, start: number) => {
      try {
        const summary = await fetchSummary(serverUrl, { projectId, unitId, since: start })
        setSittingXp(summary.xp)
      } catch {
        // The chip keeps its last value offline.
      }
    },
    [serverUrl, unitId]
  )

  // Opens the session: saved copy first, then the server; records queued answers.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const start = await sittingStart(unitId)
      if (cancelled) return
      setSince(start)
      const cached = await loadCached<MobileTeachResponse>(serverUrl, `teach:${unitId}`)
      if (cached && !cancelled) setData((current) => current ?? cached.value)
      const fresh = await load()
      if (!fresh || cancelled) return
      await flushTeachAnswers(serverUrl)
      void refreshXp(fresh.unit.projectId, start)
    })()
    return () => {
      cancelled = true
      abortRef.current?.abort()
    }
  }, [serverUrl, unitId, load, refreshXp])

  // Creates the session on first visit once the unit has readable material.
  useEffect(() => {
    if (!data || offline || data.chatId || !data.unit.hasText || startingRef.current) return
    startingRef.current = true
    startTeach(serverUrl, unitId)
      .then(() => load())
      .catch((caught) => setError(caught instanceof Error ? caught.message : "This unit could not be opened."))
      .finally(() => {
        startingRef.current = false
      })
  }, [data, offline, serverUrl, unitId, load])

  const running = data?.status === "running" || sending

  // Re-reads the saved reply while the tutor writes, then once more when it finishes.
  useEffect(() => {
    if (!running) {
      if (wasRunning.current && data) {
        wasRunning.current = false
        void load()
        if (since) void refreshXp(data.unit.projectId, since)
      }
      return
    }
    wasRunning.current = true
    const timer = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(timer)
  }, [running, load, refreshXp, since, data])

  /** Sends a learner message or quick reply, or continues a paused reply. */
  const send = useCallback(
    async (message: string, continuationOf?: string) => {
      if (!data?.chatId || sending || data.status === "running" || offline) return
      setSending(true)
      setError("")
      revealId.current = "next"
      const controller = new AbortController()
      abortRef.current = controller
      try {
        await sendTeachTurn(
          serverUrl,
          { chatId: data.chatId, message, ...(continuationOf ? { continuationOf } : {}) },
          controller.signal
        )
      } catch (caught) {
        if (!(caught instanceof Error && caught.name === "AbortError"))
          setError(caught instanceof MobileApiError ? caught.message : "The tutor could not reply. Try again.")
      } finally {
        abortRef.current = null
        setSending(false)
        void load()
      }
    },
    [data?.chatId, data?.status, sending, offline, serverUrl, load]
  )

  // Starts teaching as soon as a new session opens; the learner chose this unit.
  useEffect(() => {
    if (!data?.chatId || offline || autoStarted.current) return
    if (data.status !== "idle" || data.messages.length || !data.unit.hasText) return
    if (initialAsk && !askSent.current) return
    autoStarted.current = true
    void send(TEACH_QUICK_REPLIES.start)
  }, [data, offline, initialAsk, send])

  // Sends a Relearn request once the session is ready.
  useEffect(() => {
    if (!initialAsk || askSent.current || !data?.chatId || offline || data.status !== "idle") return
    askSent.current = true
    autoStarted.current = true
    void send(initialAsk.trim().slice(0, 4_000))
  }, [initialAsk, data, offline, send])

  /** Pauses the reply being written; the saved text stays and can be continued. */
  async function pause() {
    const active = data?.messages.findLast((message) => message.role === "assistant" && message.status === "running")
    abortRef.current?.abort()
    if (!data?.chatId || !active) return
    await pauseTeachTurn(serverUrl, data.chatId, active.id).catch(() =>
      setError("The reply could not be paused. Try again.")
    )
    void load()
  }

  /** Records a lesson quiz answer, or queues it when the server cannot be reached. */
  async function answerQuiz(messageId: string, block: QuizBlock, answer: string[]) {
    if (!data?.chatId) return
    setLocalAnswers((current) => ({ ...current, [`${messageId}:${block.id}`]: answer }))
    const entry = { chatId: data.chatId, messageId, quizId: block.id, selectedOptionIds: answer }
    try {
      if (offline) throw new MobileApiError("Could not reach Blitz on your computer")
      await answerTeachQuiz(serverUrl, entry)
      if (since) void refreshXp(data.unit.projectId, since)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : ""
      if (/reach|unreadable|\(5\d\d\)/i.test(message)) await queueTeachAnswer(serverUrl, entry)
      else setError(message || "Your answer could not be saved.")
    }
  }

  const outline: TeachOutline | null = useMemo(() => {
    if (data?.outline) return data.outline
    const first = data?.messages.find((message) => message.role === "assistant")
    return first ? (parseTeachOutline(first.content) ?? null) : null
  }, [data?.outline, data?.messages])
  const { sectionIndex, taught } = lessonPosition(data, outline)
  const sectionCount = outline?.sections.length ?? 0
  const complete = Boolean(outline) && sectionIndex >= sectionCount
  const current = outline?.sections[sectionIndex]
  const segments = outline
    ? pathSegments(
        outline.sections.map((section, index) => ({
          key: section.id,
          state: index === sectionIndex ? "current" : taught.has(section.id) || complete ? "done" : "ahead",
        }))
      )
    : []
  const lastAssistant = data?.messages.findLast((message) => message.role === "assistant")
  // A failed or paused reply can be continued (or retried when it has no text yet).
  const lastMessage = data?.messages.at(-1)
  const paused = !running && lastMessage?.role === "assistant" && lastMessage.status === "failed"

  // Brings a new reply's opening into view, or the latest reply when returning.
  useEffect(() => {
    if (!lastAssistant) return
    if (revealId.current === "next" && data?.messages.at(-1)?.role === "assistant") revealId.current = lastAssistant.id
    if (!restored.current && data && data.messages.length > 2) {
      restored.current = true
      revealId.current = lastAssistant.id
    }
    // The message may already be laid out; layout events can arrive before this effect.
    const target = revealId.current
    const y = target ? offsets.current.get(target) : undefined
    if (target && y !== undefined) {
      revealId.current = null
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
    }
  }, [lastAssistant, data])

  /** Scrolls to a message once it has been laid out. */
  function onMessageLayout(id: string, y: number) {
    offsets.current.set(id, y)
    if (revealId.current === id) {
      revealId.current = null
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
    }
  }

  if (!data)
    return (
      <View style={[styles.root, styles.centered, { paddingTop: insets.top }]}>
        {loadError ? (
          <>
            <Text style={styles.body}>{loadError}</Text>
            <Pressable accessibilityRole="button" onPress={() => void load()} style={styles.chip}>
              <Text style={styles.chipText}>Try again</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onBack} style={styles.chip}>
              <Text style={styles.chipText}>Back</Text>
            </Pressable>
          </>
        ) : (
          <ActivityIndicator color={colors.brand} />
        )}
      </View>
    )

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
      <View style={[styles.header, { paddingTop: 8 + insets.top }]}>
        <View style={styles.headerRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} style={styles.iconButton}>
            <Text style={styles.backText}>‹</Text>
          </Pressable>
          <View style={styles.headerText}>
            <Text numberOfLines={1} accessibilityRole="header" style={styles.headerTitle}>
              {data.unit.title}
            </Text>
            <Text numberOfLines={1} style={styles.small}>
              {complete
                ? "Unit complete"
                : current
                  ? `Section ${sectionIndex + 1} of ${sectionCount} · ${current.title}`
                  : running
                    ? "Preparing your lesson…"
                    : data.unit.projectTitle}
            </Text>
          </View>
          {sittingXp > 0 ? (
            <Text accessibilityLabel={`${sittingXp} XP this session`} style={styles.xp}>
              +{sittingXp} XP
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => setSummaryOpen(true)}
            style={({ pressed }) => [styles.finish, pressed && styles.pressed]}
          >
            <Text style={styles.finishText}>Finish</Text>
          </Pressable>
        </View>
        <SegmentedBar segments={segments} style={styles.headerBar} />
      </View>

      {offline ? (
        <Text style={styles.offline}>Offline · reading your saved lesson. Answers sync when you reconnect.</Text>
      ) : null}

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.lesson}
        keyboardShouldPersistTaps="handled"
      >
        {!data.unit.hasText ? (
          <Text style={styles.body}>This unit's material is still being prepared. Check back in a moment.</Text>
        ) : null}
        {data.messages.map((message) =>
          message.role === "user" ? (
            <UserMessage key={message.id} message={message} />
          ) : (
            <View key={message.id} onLayout={(event) => onMessageLayout(message.id, event.nativeEvent.layout.y)}>
              <AssistantMessage
                message={message}
                outline={outline}
                streaming={message.status === "running"}
                answered={data.answered[message.id] ?? {}}
                localAnswers={localAnswers}
                busy={running || offline}
                onAnswer={(block, answer) => void answerQuiz(message.id, block, answer)}
                onFollowup={(text) => void send(text)}
              />
            </View>
          )
        )}
        {running && lastAssistant?.status !== "running" ? (
          <View style={styles.writing}>
            <ActivityIndicator color={colors.brand} size="small" />
            <Text style={styles.small}>The tutor is writing…</Text>
          </View>
        ) : null}
        {complete && !running && since ? (
          <View style={styles.completeCard}>
            <SessionSummary
              serverUrl={serverUrl}
              projectId={data.unit.projectId}
              unitId={unitId}
              since={data.messages[0]?.createdAt ?? since}
              eyebrow="Unit complete"
              actions={
                <>
                  <PrimaryButton label="Practice this unit" onPress={() => onPractice(data.unit.projectId, unitId)} />
                  {data.unit.nextUnit ? (
                    <SecondaryButton
                      label={`Next: ${data.unit.nextUnit.title}`}
                      onPress={() => onOpenUnit(data.unit.nextUnit!.id)}
                    />
                  ) : null}
                </>
              }
            />
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: 10 + insets.bottom }]}>
        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {running ? (
          <View style={styles.composerRow}>
            <Text style={[styles.small, styles.grow]}>Writing your lesson…</Text>
            <SecondaryButton label="Pause" onPress={() => void pause()} />
          </View>
        ) : offline ? (
          <Text style={styles.small}>Connect to Blitz on your computer to keep learning.</Text>
        ) : (
          <>
            {paused && lastMessage ? (
              <PrimaryButton
                label={lastMessage.content.trim() ? "Continue the reply" : "Try again"}
                onPress={() => void send("", lastMessage.id)}
              />
            ) : !complete && data.messages.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quick}>
                {QUICK_REPLIES.map((reply, index) => (
                  <Pressable
                    key={reply.message}
                    accessibilityRole="button"
                    onPress={() => void send(reply.message)}
                    style={({ pressed }) => [styles.chip, index === 0 && styles.chipPrimary, pressed && styles.pressed]}
                  >
                    <Text style={[styles.chipText, index === 0 && styles.chipPrimaryText]}>{reply.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            <View style={styles.composerRow}>
              <TextInput
                accessibilityLabel="Ask the tutor a question"
                editable={Boolean(data.chatId)}
                multiline
                onChangeText={setDraft}
                placeholder={complete ? "Ask about this unit" : "Ask about this section"}
                placeholderTextColor={colors.faint}
                style={styles.input}
                value={draft}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send question"
                disabled={!draft.trim()}
                onPress={() => {
                  const message = draft.trim().slice(0, 4_000)
                  setDraft("")
                  void send(message)
                }}
                style={({ pressed }) => [styles.send, !draft.trim() && styles.disabled, pressed && styles.pressed]}
              >
                <Text style={styles.sendText}>↑</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      <Modal
        animationType="slide"
        transparent
        visible={summaryOpen}
        onRequestClose={() => setSummaryOpen(false)}
      >
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { paddingBottom: 20 + insets.bottom }]}>
            {since ? (
              <SessionSummary
                serverUrl={serverUrl}
                projectId={data.unit.projectId}
                unitId={unitId}
                since={since}
                eyebrow="This session"
                actions={
                  <>
                    <PrimaryButton
                      label="Done for now"
                      onPress={() => {
                        setSummaryOpen(false)
                        void restartSitting(unitId)
                        onBack()
                      }}
                    />
                    <SecondaryButton label="Keep learning" onPress={() => setSummaryOpen(false)} />
                    <SecondaryButton
                      label="Practice this unit"
                      onPress={() => {
                        setSummaryOpen(false)
                        onPractice(data.unit.projectId, unitId)
                      }}
                    />
                  </>
                }
              />
            ) : null}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  )
}

/** A learner message; quick replies show as their short label. */
function UserMessage({ message }: { readonly message: MobileTeachMessage }) {
  const label = QUICK_REPLY_LABELS.get(message.content.trim())
  if (label) return <Text style={styles.quickEcho}>{label}</Text>
  return (
    <View style={styles.userBubble}>
      <Text selectable style={styles.userText}>
        {message.content}
      </Text>
    </View>
  )
}

/** Props for one tutor reply. */
type AssistantMessageProps = {
  readonly message: MobileTeachMessage
  readonly outline: TeachOutline | null
  readonly streaming: boolean
  readonly answered: Record<string, { selectedOptionIds: string[]; correct: boolean }>
  readonly localAnswers: Record<string, string[]>
  readonly busy: boolean
  readonly onAnswer: (block: QuizBlock, answer: string[]) => void
  readonly onFollowup: (text: string) => void
}

/** A tutor reply: its section heading, lesson text, and interactive blocks. */
function AssistantMessage({
  message,
  outline,
  streaming,
  answered,
  localAnswers,
  busy,
  onAnswer,
  onFollowup,
}: AssistantMessageProps) {
  const marker = parseTeachSectionMarker(message.content)
  const plan = useMemo(() => parseTeachOutline(message.content), [message.content])
  const sectionIndex =
    marker?.kind === "section" && outline ? outline.sections.findIndex((section) => section.id === marker.id) : -1
  const sectionTitle = sectionIndex >= 0 && outline ? outline.sections[sectionIndex].title : undefined
  const parts = useMemo(
    () => withoutRepeatedHeading(teachParts(message.content, streaming), sectionTitle),
    [message.content, streaming, sectionTitle]
  )
  return (
    <View style={styles.reply}>
      {plan ? (
        <View style={styles.plan}>
          <Text style={styles.quizLabel}>Lesson plan</Text>
          <Text style={styles.planTitle}>{plan.title}</Text>
          {plan.sections.map((section, index) => (
            <Text key={section.id} style={styles.small}>
              {index + 1}. {section.title}
            </Text>
          ))}
        </View>
      ) : null}
      {sectionIndex >= 0 && outline ? (
        <View style={styles.sectionHeading}>
          <PathMarker state="current" number={sectionIndex + 1} />
          <View style={styles.grow}>
            <Text style={styles.small}>
              Section {sectionIndex + 1} of {outline.sections.length}
            </Text>
            <Text accessibilityRole="header" style={styles.sectionTitle}>
              {sectionTitle}
            </Text>
          </View>
        </View>
      ) : marker?.kind === "done" ? (
        <View>
          <Text style={styles.quizLabel}>Unit recap</Text>
          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {outline?.title ?? "Recap"}
          </Text>
        </View>
      ) : null}
      {parts.map((part, index) => {
        if (part.kind === "markdown") return <Markdown key={index} text={part.text} />
        if (part.kind === "pending")
          return (
            <Text key={index} style={styles.small}>
              {part.language === "quiz" ? "Writing a question…" : "Writing…"}
            </Text>
          )
        const block = part.block
        if (block.kind === "quiz") {
          const recorded = answered[block.id]?.selectedOptionIds ?? localAnswers[`${message.id}:${block.id}`]
          return (
            <View key={index} style={styles.quiz}>
              <Text style={styles.quizLabel}>Check yourself · {block.concept}</Text>
              <QuestionView
                shape={block}
                recordedAnswer={recorded}
                result={
                  recorded
                    ? {
                        correct: gradeQuizAnswer(block, recorded),
                        correctOptionIds: block.correctOptionIds,
                        ...(block.acceptedAnswers ? { acceptedAnswers: block.acceptedAnswers } : {}),
                        explanation: block.explanation,
                      }
                    : undefined
                }
                disabled={streaming}
                onSubmit={(answer) => onAnswer(block, answer)}
              />
            </View>
          )
        }
        if (block.kind === "steps") return <Steps key={index} block={block} />
        if (block.kind === "followups")
          return streaming ? null : (
            <View key={index} style={styles.followups}>
              {block.items.map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => onFollowup(item)}
                  style={({ pressed }) => [styles.followup, busy && styles.disabled, pressed && styles.pressed]}
                >
                  <Text style={styles.followupText}>{inlineMathToText(item)}</Text>
                </Pressable>
              ))}
            </View>
          )
        return (
          <View key={index} style={styles.viz}>
            <Text style={styles.quizLabel}>Interactive visual{block.title ? ` · ${block.title}` : ""}</Text>
            <Text style={styles.small}>Open this lesson on your computer to use it.</Text>
          </View>
        )
      })}
    </View>
  )
}

/**
 * Drops a Markdown heading at the very start of a section when it repeats the
 * section title already shown above it.
 */
function withoutRepeatedHeading(parts: ReturnType<typeof teachParts>, title: string | undefined) {
  const first = parts[0]
  if (!title || first?.kind !== "markdown") return parts
  const match = /^#{1,6}[ \t]+(.+?)[ \t#]*(?:\n|$)/.exec(first.text)
  if (!match || match[1].trim().toLowerCase() !== title.trim().toLowerCase()) return parts
  const rest = first.text.slice(match[0].length).trim()
  return rest ? [{ kind: "markdown" as const, text: rest }, ...parts.slice(1)] : parts.slice(1)
}

/** A worked example revealed one step at a time. */
function Steps({ block }: { readonly block: StepsBlock }) {
  const [shown, setShown] = useState(1)
  return (
    <View style={styles.steps}>
      {block.title ? <Text style={styles.quizLabel}>{block.title}</Text> : null}
      {block.steps.slice(0, shown).map((step, index) => (
        <View key={index} style={styles.step}>
          <Text style={styles.stepNumber}>{index + 1}</Text>
          <View style={styles.grow}>
            {step.title ? <Text style={styles.stepTitle}>{step.title}</Text> : null}
            <Markdown text={step.body} />
          </View>
        </View>
      ))}
      {shown < block.steps.length ? (
        <View style={styles.stepActions}>
          <SecondaryButton label="Show next step" onPress={() => setShown((count) => count + 1)} />
          <Pressable accessibilityRole="button" onPress={() => setShown(block.steps.length)} style={styles.textButton}>
            <Text style={styles.small}>Show all</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

/** The main action in a group. */
function PrimaryButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  )
}

/** A secondary action. */
function SecondaryButton({ label, onPress }: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
    >
      <Text numberOfLines={1} style={styles.secondaryText}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  centered: { alignItems: "center", gap: 14, justifyContent: "center", padding: 24 },
  body: { color: colors.mutedForeground, fontSize: 15, lineHeight: 22, textAlign: "center" },
  small: { color: colors.mutedForeground, fontSize: 13, lineHeight: 19 },
  grow: { flex: 1 },
  header: {
    backgroundColor: colors.background,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 10,
    paddingHorizontal: 12,
  },
  headerRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  iconButton: { alignItems: "center", height: TOUCH_TARGET, justifyContent: "center", width: 36 },
  backText: { color: colors.text, fontSize: 30, lineHeight: 32 },
  headerText: { flex: 1 },
  headerTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  xp: {
    backgroundColor: brandAlpha(0.12),
    borderRadius: radius.pill,
    color: colors.brand,
    fontSize: 12,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  finish: {
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 36,
    paddingHorizontal: 12,
  },
  finishText: { color: colors.text, fontSize: 13 },
  headerBar: { marginTop: 8, paddingHorizontal: 4 },
  offline: {
    backgroundColor: colors.card,
    color: colors.mutedForeground,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  lesson: { gap: 20, padding: 18, paddingBottom: 40 },
  reply: { gap: 14 },
  sectionHeading: { alignItems: "flex-start", flexDirection: "row", gap: 12, marginTop: 8 },
  sectionTitle: { color: colors.foreground, fontSize: 20, fontWeight: "600", lineHeight: 26 },
  plan: { backgroundColor: colors.card, borderRadius: radius.lg, gap: 4, padding: 14 },
  planTitle: { color: colors.foreground, fontSize: 16, fontWeight: "600", marginBottom: 4 },
  quickEcho: { alignSelf: "flex-end", color: colors.faint, fontSize: 12 },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: colors.muted,
    borderRadius: radius.lg,
    maxWidth: "85%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userText: { color: colors.foreground, fontSize: 15, lineHeight: 22 },
  writing: { alignItems: "center", flexDirection: "row", gap: 10 },
  quiz: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  quizLabel: { color: colors.brand, fontSize: 12, fontWeight: "600" },
  steps: {
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 12,
    padding: 14,
  },
  step: { flexDirection: "row", gap: 10 },
  stepNumber: { color: colors.brand, fontSize: 14, fontWeight: "700", width: 18 },
  stepTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600", marginBottom: 4 },
  stepActions: { alignItems: "center", flexDirection: "row", gap: 12 },
  textButton: { justifyContent: "center", minHeight: TOUCH_TARGET, paddingHorizontal: 6 },
  followups: { gap: 8 },
  followup: {
    alignSelf: "flex-start",
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  followupText: { color: colors.text, fontSize: 14 },
  viz: { backgroundColor: colors.card, borderRadius: radius.lg, gap: 4, padding: 14 },
  completeCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    padding: 18,
  },
  composer: {
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  composerRow: { alignItems: "flex-end", flexDirection: "row", gap: 8 },
  quick: { gap: 8, paddingRight: 8 },
  chip: {
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 14,
  },
  chipPrimary: { backgroundColor: colors.brand, borderColor: colors.brand },
  chipText: { color: colors.text, fontSize: 14 },
  chipPrimaryText: { color: colors.brandForeground, fontWeight: "600" },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    color: colors.foreground,
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  send: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: 999,
    height: TOUCH_TARGET,
    justifyContent: "center",
    width: TOUCH_TARGET,
  },
  sendText: { color: colors.brandForeground, fontSize: 20, fontWeight: "700" },
  error: { color: "#ff9a89", fontSize: 13, lineHeight: 19 },
  primary: {
    alignItems: "center",
    backgroundColor: colors.brand,
    borderRadius: radius.pill,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 20,
  },
  primaryText: { color: colors.brandForeground, fontSize: 15, fontWeight: "600" },
  secondary: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: 18,
  },
  secondaryText: { color: colors.text, fontSize: 14 },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.72 },
  sheetBackdrop: { backgroundColor: "#000000aa", flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    maxHeight: "88%",
    padding: 20,
  },
})
