/** Renders native source entry points and preparation states for a project workspace. */

import { useMemo, useState } from "react"
import { Pressable, StyleSheet, View } from "react-native"

import {
  createProjectSource,
  importProjectLink,
  retryProjectSource,
  type MobileWorkspaceIngestion,
  type MobileWorkspacePreparation,
  type MobileWorkspaceSource,
} from "../lib/project-workspace-api"
import { Text, TextInput } from "./native-text"

/** Props for the mobile source manager and its parent-owned file fallback. */
export type SourceManagementProps = {
  readonly baseUrl: string
  readonly projectId: string
  readonly sources: MobileWorkspaceSource[]
  readonly ingestion?: MobileWorkspaceIngestion[]
  readonly preparation?: MobileWorkspacePreparation[]
  readonly onOpenSource?: (source: MobileWorkspaceSource) => void
  readonly onUploadFiles?: () => void
  readonly onChanged?: () => void
}

/** Formats a source lifecycle into the same labels used by the web file list. */
function sourceState(
  source: MobileWorkspaceSource,
  ingestion: MobileWorkspaceIngestion[],
  preparation: MobileWorkspacePreparation[]
): { label: string; tone: "muted" | "error" | "ready" } {
  const ingest = ingestion.find((job) => job.sourceId === source.id)
  const prepare = preparation.find((job) => job.sourceId === source.id)
  if (source.unsupported) return { label: "Unsupported file", tone: "muted" }
  if (
    source.status === "failed" ||
    ingest?.status === "failed" ||
    prepare?.status === "failed" ||
    prepare?.leaseExpired
  )
    return { label: "Needs attention", tone: "error" }
  if (ingest?.status === "queued") return { label: "Queued", tone: "muted" }
  if (ingest?.status === "running") return { label: "Ingesting", tone: "muted" }
  if (prepare?.status === "queued") return { label: "Queued", tone: "muted" }
  if (prepare?.status === "leased" || source.status === "processing")
    return { label: "Preparing", tone: "muted" }
  return { label: "Ready", tone: "ready" }
}

/** Returns preparation progress when the server knows the chunk count. */
function progress(
  preparation: MobileWorkspacePreparation | undefined
): number | undefined {
  if (!preparation?.totalChunks || preparation.totalChunks <= 0)
    return undefined
  return Math.min(
    100,
    Math.round(
      ((preparation.nextChunkOrdinal ?? 0) / preparation.totalChunks) * 100
    )
  )
}

/** Renders upload, paste, link, source rows, and retryable preparation errors. */
export function SourceManagement({
  baseUrl,
  projectId,
  sources,
  ingestion = [],
  preparation = [],
  onOpenSource,
  onUploadFiles,
  onChanged,
}: SourceManagementProps) {
  const [mode, setMode] = useState<"upload" | "paste" | "link">("upload")
  const [text, setText] = useState("")
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const [retrying, setRetrying] = useState<string>()
  const states = useMemo(
    () =>
      new Map(
        sources.map((source) => [
          source.id,
          sourceState(source, ingestion, preparation),
        ])
      ),
    [ingestion, preparation, sources]
  )

  /** Queues pasted notes or a public link and keeps recovery copy visible. */
  async function submit(): Promise<void> {
    if (busy) return
    setBusy(true)
    setMessage("")
    try {
      if (mode === "paste") {
        if (!text.trim()) throw new Error("Paste notes before adding a source.")
        await createProjectSource(baseUrl, projectId, {
          action: "paste",
          text: text.trim(),
          filename: "Pasted notes.txt",
        })
        setText("")
        setMessage("Notes queued for preparation.")
        onChanged?.()
      } else if (mode === "link") {
        if (!url.trim()) throw new Error("Enter a public source link.")
        await importProjectLink(baseUrl, projectId, url.trim())
        setUrl("")
        setMessage("Link queued for preparation.")
        onChanged?.()
      }
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The source could not be added."
      )
    } finally {
      setBusy(false)
    }
  }

  /** Retries ingestion for a source and leaves the row available when it fails. */
  async function retry(sourceId: string): Promise<void> {
    setRetrying(sourceId)
    setMessage("")
    try {
      await retryProjectSource(baseUrl, projectId, sourceId)
      onChanged?.()
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The source could not be retried."
      )
    } finally {
      setRetrying(undefined)
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Sources</Text>
      <Text style={styles.description}>
        Add the material you want to study.
      </Text>
      <View style={styles.tabs}>
        {(["upload", "paste", "link"] as const).map((item) => (
          <Pressable
            key={item}
            accessibilityRole="tab"
            accessibilityState={{ selected: mode === item }}
            onPress={() => setMode(item)}
            style={[styles.tab, mode === item && styles.activeTab]}
          >
            <Text
              style={[styles.tabText, mode === item && styles.activeTabText]}
            >
              {item === "upload"
                ? "Upload"
                : item === "paste"
                  ? "Paste"
                  : "Link"}
            </Text>
          </Pressable>
        ))}
      </View>
      {mode === "upload" ? (
        <View style={styles.entry}>
          <Text style={styles.entryTitle}>Upload files</Text>
          <Text style={styles.entryHint}>
            PDF, MD, TXT, or PPTX. Files are copied to your project and prepared
            in the background.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onUploadFiles}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>
              {onUploadFiles ? "Choose files" : "Upload in web app"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {mode === "paste" ? (
        <View style={styles.entry}>
          <TextInput
            accessibilityLabel="Pasted source notes"
            value={text}
            onChangeText={setText}
            multiline
            placeholder="Paste notes here"
            placeholderTextColor="#858585"
            style={[styles.input, styles.multiline]}
            maxLength={2_000_000}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void submit()}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>
              {busy ? "Adding…" : "Add notes"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {mode === "link" ? (
        <View style={styles.entry}>
          <TextInput
            accessibilityLabel="Public source link"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://example.com/notes"
            placeholderTextColor="#858585"
            style={styles.input}
            maxLength={2_048}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void submit()}
            style={styles.primary}
          >
            <Text style={styles.primaryText}>
              {busy ? "Fetching…" : "Add link"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {message ? (
        <Text accessibilityRole="alert" style={styles.message}>
          {message}
        </Text>
      ) : null}
      <View style={styles.list}>
        {sources.length ? (
          sources.map((source) => {
            const state = states.get(source.id) ?? {
              label: "Preparing",
              tone: "muted" as const,
            }
            const job = preparation.find((item) => item.sourceId === source.id)
            const percent = progress(job)
            return (
              <View key={source.id} style={styles.sourceRow}>
                <View style={styles.sourceTop}>
                  <View style={styles.sourceCopy}>
                    <Text style={styles.filename} numberOfLines={2}>
                      {source.filename}
                    </Text>
                    <Text style={styles.meta}>
                      {source.kind ?? source.mimeType ?? "Local source"}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.state,
                      state.tone === "error" && styles.errorText,
                      state.tone === "ready" && styles.readyText,
                    ]}
                  >
                    {state.label}
                  </Text>
                </View>
                {percent !== undefined ? (
                  <Text style={styles.progressText}>
                    Preparing study material · {percent}%
                  </Text>
                ) : null}
                <View style={styles.rowActions}>
                  {onOpenSource ? (
                    <Pressable onPress={() => onOpenSource(source)}>
                      <Text style={styles.linkText}>Overview & preview</Text>
                    </Pressable>
                  ) : null}
                  {state.tone === "error" ? (
                    <Pressable
                      disabled={retrying === source.id}
                      onPress={() => void retry(source.id)}
                    >
                      <Text style={styles.retryText}>
                        {retrying === source.id ? "Retrying…" : "Retry"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
                {source.error ? (
                  <Text style={styles.errorDetail}>{source.error}</Text>
                ) : null}
              </View>
            )
          })
        ) : (
          <Text style={styles.empty}>
            No source files yet. Add a source above to make it available for
            study.
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { color: "#f7f7f7", fontSize: 23, fontWeight: "700" },
  description: { color: "#aaaaaa", fontSize: 14 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: {
    borderColor: "#383838",
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  activeTab: { backgroundColor: "#ff8065", borderColor: "#ff8065" },
  tabText: { color: "#aaaaaa", fontSize: 13, fontWeight: "600" },
  activeTabText: { color: "#1b0d0a" },
  entry: {
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  entryTitle: { color: "#f7f7f7", fontSize: 16, fontWeight: "700" },
  entryHint: { color: "#aaaaaa", fontSize: 13, lineHeight: 19 },
  input: {
    backgroundColor: "#111111",
    borderColor: "#424242",
    borderRadius: 10,
    borderWidth: 1,
    color: "#f7f7f7",
    minHeight: 46,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 120, textAlignVertical: "top" },
  primary: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#ff8065",
    borderRadius: 10,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  primaryText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
  message: { color: "#aaaaaa", fontSize: 13 },
  list: { gap: 10 },
  sourceRow: {
    borderBottomColor: "#303030",
    borderBottomWidth: 1,
    paddingVertical: 13,
  },
  sourceTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  sourceCopy: { flex: 1, gap: 4 },
  filename: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  meta: { color: "#858585", fontSize: 12 },
  state: { color: "#aaaaaa", fontSize: 12, fontWeight: "700" },
  readyText: { color: "#8fdda9" },
  errorText: { color: "#ff8c86" },
  progressText: { color: "#858585", fontSize: 12, marginTop: 9 },
  rowActions: { flexDirection: "row", gap: 18, marginTop: 9 },
  linkText: { color: "#ff8065", fontSize: 13, fontWeight: "600" },
  retryText: { color: "#ff8c86", fontSize: 13, fontWeight: "700" },
  errorDetail: { color: "#ff8c86", fontSize: 12, lineHeight: 18, marginTop: 8 },
  empty: {
    borderColor: "#383838",
    borderRadius: 12,
    borderStyle: "dashed",
    borderWidth: 1,
    color: "#858585",
    fontSize: 14,
    lineHeight: 20,
    padding: 15,
  },
})
