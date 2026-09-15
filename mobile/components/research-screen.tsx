/** Renders the native approval-first research flow used by a project workspace. */

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  applyResearchSources,
  fetchLatestResearch,
  fetchResearch,
  fetchResearchImports,
  queueResearch,
  retryResearch,
  type MobileResearchImport,
  type MobileResearchSnapshot,
} from "../lib/research"
import { Text, TextInput } from "./native-text"
import { WebArrowLeftIcon, WebCheckIcon } from "./web-icon"

/** Props for one project-scoped native research screen. */
export type ResearchScreenProps = {
  readonly serverUrl: string
  readonly projectId: string
  readonly onClose: () => void
  readonly onChanged?: () => void
}

/** Returns whether an import row prevents selecting that proposal source again. */
function isLocked(status: MobileResearchImport["status"] | undefined): boolean {
  return status === "queued" || status === "running" || status === "imported"
}

/** Returns a short status label for a persisted research import. */
function importLabel(
  status: MobileResearchImport["status"] | undefined
): string {
  if (status === "queued") return "Queued"
  if (status === "running") return "Importing…"
  if (status === "imported") return "Downloaded"
  if (status === "failed") return "Import failed"
  return "Not selected"
}

/** Returns a short status label for the current research proposal. */
function proposalLabel(snapshot: MobileResearchSnapshot | undefined): string {
  if (!snapshot) return ""
  if (snapshot.status === "queued") return "Queued"
  if (snapshot.status === "running") return "Finding sources…"
  if (snapshot.status === "ready") return "Ready to review"
  return "Research could not be prepared"
}

/** Renders research planning, explicit source selection, and retry states. */
export function ResearchScreen({
  serverUrl,
  projectId,
  onClose,
  onChanged,
}: ResearchScreenProps) {
  const insets = useSafeAreaInsets()
  const [requestText, setRequestText] = useState("")
  const [snapshot, setSnapshot] = useState<MobileResearchSnapshot | null>()
  const [imports, setImports] = useState<MobileResearchImport[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<"propose" | "retry" | "apply">()
  const [error, setError] = useState("")

  /** Loads the latest persisted proposal when the screen opens. */
  const loadLatest = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const latest = await fetchLatestResearch(serverUrl, projectId)
      setSnapshot(latest)
      setRequestText(latest?.request ?? "")
      if (latest?.proposal) {
        setSelected(new Set(latest.proposal.sources.map((_, index) => index)))
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Research could not be loaded"
      )
    } finally {
      setLoading(false)
    }
  }, [projectId, serverUrl])

  useEffect(() => {
    void loadLatest()
  }, [loadLatest])

  useEffect(() => {
    if (!snapshot?.requestId) return
    const controller = new AbortController()
    const poll = async () => {
      try {
        const next = await fetchResearch(
          serverUrl,
          projectId,
          snapshot.requestId,
          controller.signal
        )
        if (next) {
          setSnapshot(next)
          if (next.proposal && snapshot.status !== "ready") {
            setSelected(new Set(next.proposal.sources.map((_, index) => index)))
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Research could not be refreshed"
          )
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 3_000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [projectId, serverUrl, snapshot?.requestId, snapshot?.status])

  useEffect(() => {
    if (!snapshot?.requestId || snapshot.status !== "ready") return
    const controller = new AbortController()
    const poll = async () => {
      try {
        setImports(
          await fetchResearchImports(
            serverUrl,
            projectId,
            snapshot.requestId,
            controller.signal
          )
        )
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Import status could not be loaded"
          )
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 3_000)
    return () => {
      controller.abort()
      clearInterval(interval)
    }
  }, [projectId, serverUrl, snapshot?.requestId, snapshot?.status])

  /** Queues a new research request and selects every returned source for review. */
  async function propose(): Promise<void> {
    const request = requestText.trim()
    if (!request || pending) return
    setPending("propose")
    setError("")
    setImports([])
    try {
      const next = await queueResearch(serverUrl, projectId, request)
      setSnapshot(next)
      setSelected(new Set())
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Research could not be queued"
      )
    } finally {
      setPending(undefined)
    }
  }

  /** Requeues the current failed proposal without changing its request identity. */
  async function retry(): Promise<void> {
    if (!snapshot || pending) return
    setPending("retry")
    setError("")
    try {
      await retryResearch(serverUrl, projectId, snapshot.requestId)
      setSnapshot((current) =>
        current ? { ...current, status: "queued", error: undefined } : current
      )
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Research could not be retried"
      )
    } finally {
      setPending(undefined)
    }
  }

  /** Enqueues only the currently selected suggested sources. */
  async function apply(): Promise<void> {
    if (!snapshot?.proposal || snapshot.status !== "ready" || pending) return
    const rows = new Map(imports.map((item) => [item.sourceIndex, item]))
    const indexes = [...selected]
      .filter((index) => !isLocked(rows.get(index)?.status))
      .sort((left, right) => left - right)
    if (!indexes.length) return
    setPending("apply")
    setError("")
    try {
      const nextImports = await applyResearchSources(
        serverUrl,
        projectId,
        snapshot.requestId,
        indexes
      )
      setImports((current) => {
        const merged = new Map(
          current.map((item) => [item.sourceIndex, item] as const)
        )
        nextImports.forEach((item) => merged.set(item.sourceIndex, item))
        return [...merged.values()].sort(
          (left, right) => left.sourceIndex - right.sourceIndex
        )
      })
      setSelected(
        (current) =>
          new Set([...current].filter((index) => !indexes.includes(index)))
      )
      onChanged?.()
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Sources could not be imported"
      )
    } finally {
      setPending(undefined)
    }
  }

  /** Toggles one source while honoring durable import state. */
  function toggle(index: number): void {
    const row = imports.find((item) => item.sourceIndex === index)
    if (isLocked(row?.status)) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /** Opens a suggested source in the device browser and reports unavailable handlers. */
  async function openSuggestedSource(url: string): Promise<void> {
    try {
      await Linking.openURL(url)
    } catch {
      setError("Could not open that source link")
    }
  }

  const importRows = useMemo(
    () => new Map(imports.map((item) => [item.sourceIndex, item])),
    [imports]
  )
  const canApply = Boolean(
    snapshot?.status === "ready" &&
    snapshot.proposal?.sources.length &&
    [...selected].some((index) => !isLocked(importRows.get(index)?.status))
  )

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Pressable
          accessibilityRole="button"
          onPress={onClose}
          style={styles.back}
        >
          <WebArrowLeftIcon size={21} color="#f7f7f7" strokeWidth={1.8} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Find sources</Text>
          <Text style={styles.subtitle}>Research for this project</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 92 },
        ]}
      >
        <Text style={styles.label}>What do you want to learn?</Text>
        <TextInput
          accessibilityLabel="Research request"
          multiline
          maxLength={2_000}
          onChangeText={(value) => {
            setRequestText(value)
            setError("")
          }}
          placeholder="e.g. Learn the basics of sound design"
          placeholderTextColor="#707070"
          style={styles.textInput}
          textAlignVertical="top"
          value={requestText}
        />
        <View style={styles.requestRow}>
          <Pressable
            accessibilityRole="button"
            disabled={!requestText.trim() || Boolean(pending)}
            onPress={() => void propose()}
            style={[
              styles.primary,
              (!requestText.trim() || pending) && styles.disabled,
            ]}
          >
            <Text style={styles.primaryText}>
              {pending === "propose" ? "Preparing…" : "Propose sources"}
            </Text>
          </Pressable>
          {snapshot ? (
            <Text style={styles.status}>{proposalLabel(snapshot)}</Text>
          ) : null}
        </View>
        {loading ? (
          <ActivityIndicator color="#ff8065" style={styles.spinner} />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {snapshot?.status === "failed" ? (
          <View style={styles.failure}>
            <Text style={styles.error}>
              {snapshot.error ?? "Research could not be prepared."}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(pending)}
              onPress={() => void retry()}
              style={styles.secondary}
            >
              <Text style={styles.secondaryText}>
                {pending === "retry" ? "Retrying…" : "Retry"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        {snapshot?.status === "ready" && snapshot.proposal ? (
          <View style={styles.plan}>
            <Text style={styles.scope}>{snapshot.proposal.scope}</Text>
            {snapshot.proposal.topics.length ? (
              <Text style={styles.topics}>
                {snapshot.proposal.topics.join(" · ")}
              </Text>
            ) : null}
            <Text style={styles.sectionTitle}>
              Suggested sources · not checked yet
            </Text>
            {snapshot.proposal.sources.map((source, index) => {
              const row = importRows.get(index)
              const locked = isLocked(row?.status)
              const checked = selected.has(index) && !locked
              return (
                <View key={`${source.url}-${index}`} style={styles.sourceRow}>
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked,
                      disabled: locked || Boolean(pending),
                    }}
                    disabled={locked || Boolean(pending)}
                    onPress={() => toggle(index)}
                    style={styles.sourceCheck}
                  >
                    <View
                      style={[
                        styles.checkbox,
                        checked && styles.checkboxChecked,
                      ]}
                    >
                      {checked ? (
                        <WebCheckIcon
                          size={15}
                          color="#1b0d0a"
                          strokeWidth={2}
                        />
                      ) : null}
                    </View>
                    <View style={styles.sourceCopy}>
                      <Text style={styles.sourceTitle}>{source.title}</Text>
                      <Text style={styles.sourceReason}>{source.reason}</Text>
                      <Text style={styles.sourceStatus}>
                        {row ? importLabel(row.status) : "Not selected"}
                      </Text>
                    </View>
                  </Pressable>
                  <Pressable
                    accessibilityRole="link"
                    onPress={() => void openSuggestedSource(source.url)}
                  >
                    <Text style={styles.openLink}>Open</Text>
                  </Pressable>
                </View>
              )
            })}
            <Pressable
              accessibilityRole="button"
              disabled={!canApply || Boolean(pending)}
              onPress={() => void apply()}
              style={[
                styles.primary,
                (!canApply || pending) && styles.disabled,
              ]}
            >
              <Text style={styles.primaryText}>
                {pending === "apply" ? "Importing…" : "Import selected sources"}
              </Text>
            </Pressable>
            <Text style={styles.note}>
              Blitz will download only the sources you approve. They are then
              prepared for study in the background.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { backgroundColor: "#0b0b0b", flex: 1 },
  header: {
    alignItems: "center",
    borderBottomColor: "#ffffff14",
    borderBottomWidth: 1,
    flexDirection: "row",
    paddingBottom: 12,
    paddingHorizontal: 16,
  },
  back: {
    alignItems: "center",
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  backText: {
    color: "#f7f7f7",
    fontSize: 36,
    fontWeight: "300",
    lineHeight: 38,
  },
  headerCopy: { alignItems: "center", flex: 1 },
  headerSpacer: { width: 42 },
  title: { color: "#f7f7f7", fontSize: 18, fontWeight: "700" },
  subtitle: { color: "#858585", fontSize: 12, marginTop: 3 },
  content: { gap: 13, paddingHorizontal: 18, paddingTop: 20 },
  label: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  textInput: {
    backgroundColor: "#171717",
    borderColor: "#383838",
    borderRadius: 13,
    borderWidth: 1,
    color: "#f7f7f7",
    minHeight: 118,
    paddingHorizontal: 13,
    paddingVertical: 12,
    fontSize: 15,
    lineHeight: 22,
  },
  requestRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  primary: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#ff8065",
    borderRadius: 11,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  primaryText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
  secondary: {
    alignItems: "center",
    borderColor: "#424242",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  secondaryText: { color: "#f7f7f7", fontSize: 13, fontWeight: "700" },
  disabled: { opacity: 0.42 },
  status: { color: "#aaaaaa", fontSize: 13 },
  spinner: { alignSelf: "flex-start", marginVertical: 4 },
  error: { color: "#ff8c86", fontSize: 13, lineHeight: 19 },
  failure: {
    backgroundColor: "#291717",
    borderColor: "#5c2929",
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    padding: 13,
  },
  plan: {
    borderTopColor: "#303030",
    borderTopWidth: 1,
    gap: 13,
    paddingTop: 18,
  },
  scope: { color: "#c8c8c8", fontSize: 14, lineHeight: 21 },
  topics: { color: "#858585", fontSize: 12, lineHeight: 18 },
  sectionTitle: {
    color: "#f7f7f7",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 5,
  },
  sourceRow: {
    alignItems: "flex-start",
    backgroundColor: "#171717",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    padding: 12,
  },
  sourceCheck: {
    alignItems: "flex-start",
    flex: 1,
    flexDirection: "row",
    gap: 10,
  },
  checkbox: {
    alignItems: "center",
    borderColor: "#707070",
    borderRadius: 5,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    marginTop: 1,
    width: 22,
  },
  checkboxChecked: { backgroundColor: "#ff8065", borderColor: "#ff8065" },
  checkboxText: { color: "#1b0d0a", fontSize: 15, fontWeight: "800" },
  sourceCopy: { flex: 1, gap: 4 },
  sourceTitle: {
    color: "#f7f7f7",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 19,
  },
  sourceReason: { color: "#aaaaaa", fontSize: 12, lineHeight: 18 },
  sourceStatus: { color: "#858585", fontSize: 11, fontWeight: "600" },
  openLink: { color: "#ff8065", fontSize: 12, fontWeight: "700", padding: 4 },
  note: { color: "#707070", fontSize: 11, lineHeight: 17 },
})
