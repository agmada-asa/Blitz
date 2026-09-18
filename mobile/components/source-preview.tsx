/** Renders a native source overview with metadata, extracted text, and preview actions. */

import { useCallback, useEffect, useState, type ReactElement } from "react"
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Markdown } from "./markdown"
import { Text } from "./native-text"
import { WebArrowLeftIcon, WebCheckIcon } from "./web-icon"
import type { MobileWorkspaceSource } from "../lib/project-workspace-api"
import {
  fetchSourceDetail,
  sourceFileUrl,
  type MobileSourceDetail,
} from "../lib/source-preview"

/** Props for a project-scoped native source preview. */
export type SourcePreviewProps = {
  readonly baseUrl: string
  readonly projectId: string
  readonly source: MobileWorkspaceSource
  readonly onClose: () => void
  readonly onRetry?: (sourceId: string) => Promise<void>
}

/** Formats a byte count in the compact form used by the web overview. */
function formatSize(sizeBytes?: number): string | undefined {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return undefined
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Formats an epoch timestamp for the source details list. */
function formatDate(timestamp?: number): string | undefined {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** Returns a friendly status label for one source lifecycle state. */
function statusLabel(
  source: MobileSourceDetail | MobileWorkspaceSource
): string {
  if (source.unsupported) return "Unsupported file"
  if (source.status === "failed") return "Needs attention"
  if (source.status === "processing") return "Preparing"
  return "Ready"
}

/** Renders the source overview and preview tabs with recovery for unavailable data. */
export function SourcePreview({
  baseUrl,
  projectId,
  source,
  onClose,
  onRetry,
}: SourcePreviewProps) {
  const insets = useSafeAreaInsets()
  const [detail, setDetail] = useState<MobileSourceDetail>()
  const [tab, setTab] = useState<"overview" | "preview" | "text">("overview")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [retrying, setRetrying] = useState(false)

  /** Loads the latest source record, including safe extracted text. */
  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true)
      setError("")
      try {
        const next = await fetchSourceDetail(
          baseUrl,
          projectId,
          source.id,
          signal
        )
        setDetail(next)
        if (next.extractedText) setTab("preview")
      } catch (cause) {
        if (!signal?.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Source preview could not be loaded"
          )
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [baseUrl, projectId, source.id]
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  /** Opens the original file through the server's ownership-checked endpoint. */
  async function openOriginal(): Promise<void> {
    try {
      await Linking.openURL(sourceFileUrl(baseUrl, projectId, source.id))
    } catch {
      Alert.alert(
        "Could not open file",
        "Try again or download it from the project workspace."
      )
    }
  }

  /** Retries failed processing and reloads the source status. */
  async function retry(): Promise<void> {
    if (!onRetry || retrying) return
    setRetrying(true)
    setError("")
    try {
      await onRetry(source.id)
      await load()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Source processing could not be retried"
      )
    } finally {
      setRetrying(false)
    }
  }

  const visible = detail ?? source
  const extractedText = detail?.extractedText ?? ""
  const isMarkdown =
    visible.kind === "markdown" || /\.(md|markdown)$/i.test(visible.filename)
  const hasPreview = Boolean(extractedText) || visible.kind === "pdf"

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to project"
          onPress={onClose}
          style={styles.back}
        >
          <WebArrowLeftIcon size={21} color="#f7f7f7" strokeWidth={1.8} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text numberOfLines={1} style={styles.title}>
            {visible.filename}
          </Text>
          <Text style={styles.subtitle}>{statusLabel(visible)}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open original file"
          onPress={() => void openOriginal()}
          style={styles.openButton}
        >
          <Text style={styles.openText}>Open</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: tab === "overview" }}
          onPress={() => setTab("overview")}
          style={[styles.tab, tab === "overview" && styles.activeTab]}
        >
          <Text
            style={[styles.tabText, tab === "overview" && styles.activeTabText]}
          >
            Overview
          </Text>
        </Pressable>
        {hasPreview ? (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === "preview" }}
            onPress={() => setTab("preview")}
            style={[styles.tab, tab === "preview" && styles.activeTab]}
          >
            <Text
              style={[
                styles.tabText,
                tab === "preview" && styles.activeTabText,
              ]}
            >
              Preview
            </Text>
          </Pressable>
        ) : null}
        {extractedText ? (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === "text" }}
            onPress={() => setTab("text")}
            style={[styles.tab, tab === "text" && styles.activeTab]}
          >
            <Text
              style={[styles.tabText, tab === "text" && styles.activeTabText]}
            >
              Extracted text
            </Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 28 },
        ]}
      >
        {loading && !detail ? (
          <ActivityIndicator color="#ff8065" style={styles.spinner} />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        ) : null}
        {visible.status === "failed" || visible.error ? (
          <View style={styles.failure}>
            <Text style={styles.failureTitle}>Preparation failed</Text>
            <Text style={styles.error}>
              {visible.error ?? "This source could not be prepared for study."}
            </Text>
            {onRetry ? (
              <Pressable
                accessibilityRole="button"
                disabled={retrying}
                onPress={() => void retry()}
                style={styles.retry}
              >
                <Text style={styles.retryText}>
                  {retrying ? "Retrying…" : "Retry processing"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {tab === "overview" ? (
          <View style={styles.group}>
            <Text style={styles.sectionTitle}>Summary</Text>
            <Text style={styles.body}>
              {detail?.summary ?? "No summary available for this source."}
            </Text>
            <Text style={styles.sectionTitle}>File details</Text>
            <View style={styles.details}>
              <Detail label="Filename" value={visible.filename} />
              <Detail label="Status" value={statusLabel(visible)} />
              {visible.mimeType ? (
                <Detail label="MIME type" value={visible.mimeType} />
              ) : null}
              {visible.sizeBytes !== undefined ? (
                <Detail
                  label="File size"
                  value={formatSize(visible.sizeBytes) ?? "Unknown"}
                />
              ) : null}
              {detail?.createdAt ? (
                <Detail
                  label="Date added"
                  value={formatDate(detail.createdAt) ?? "Unknown"}
                />
              ) : null}
              {visible.originalUrl ? (
                <Detail label="Original URL" value={visible.originalUrl} />
              ) : null}
            </View>
            {detail?.citations.length ? (
              <>
                <Text style={styles.sectionTitle}>
                  Indexed citations ({detail.citations.length})
                </Text>
                <View style={styles.details}>
                  {detail.citations.map((citation, index) => (
                    <View
                      key={`${citation.label}-${index}`}
                      style={styles.citationRow}
                    >
                      <WebCheckIcon size={15} color="#ff8065" strokeWidth={2} />
                      <Text style={styles.body}>
                        {citation.label}
                        {citation.detail ? ` · ${citation.detail}` : ""}
                      </Text>
                    </View>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        ) : null}
        {tab === "preview" ? (
          <View style={styles.group}>
            {visible.kind === "pdf" && !extractedText ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>PDF preview</Text>
                <Text style={styles.body}>
                  Open the original file to read this PDF on your device.
                </Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void openOriginal()}
                  style={styles.primary}
                >
                  <Text style={styles.primaryText}>Open file</Text>
                </Pressable>
              </View>
            ) : isMarkdown ? (
              <View style={styles.markdown}>
                <Markdown text={extractedText} />
              </View>
            ) : extractedText ? (
              <Text selectable style={styles.extracted}>
                {extractedText}
              </Text>
            ) : (
              <Text style={styles.body}>
                Preview is not available for this file yet.
              </Text>
            )}
          </View>
        ) : null}
        {tab === "text" ? (
          <View style={styles.group}>
            <Text style={styles.caption}>
              This is the text used to generate study material and search the
              source.
            </Text>
            <Text selectable style={styles.extracted}>
              {extractedText}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}

/** Renders one labeled source metadata value. */
function Detail({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): ReactElement {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text selectable style={styles.detailValue}>
        {value}
      </Text>
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
    paddingHorizontal: 14,
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
  headerCopy: { alignItems: "center", flex: 1, gap: 3 },
  title: { color: "#f7f7f7", fontSize: 16, fontWeight: "700", maxWidth: "90%" },
  subtitle: { color: "#aaaaaa", fontSize: 12 },
  openButton: { minHeight: 42, justifyContent: "center", paddingHorizontal: 7 },
  openText: { color: "#ff8065", fontSize: 13, fontWeight: "700" },
  tabs: {
    borderBottomColor: "#ffffff14",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  tab: {
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  activeTab: { borderBottomColor: "#ff8065" },
  tabText: { color: "#858585", fontSize: 13, fontWeight: "600" },
  activeTabText: { color: "#f7f7f7" },
  content: { gap: 16, paddingHorizontal: 18, paddingTop: 18 },
  spinner: { alignSelf: "flex-start" },
  error: { color: "#ff8c86", fontSize: 13, lineHeight: 19 },
  failure: {
    backgroundColor: "#291717",
    borderColor: "#5c2929",
    borderRadius: 12,
    borderWidth: 1,
    gap: 7,
    padding: 13,
  },
  failureTitle: { color: "#ffb0aa", fontSize: 14, fontWeight: "700" },
  retry: {
    alignSelf: "flex-start",
    borderColor: "#704040",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  retryText: { color: "#ffb0aa", fontSize: 13, fontWeight: "700" },
  group: { gap: 13 },
  sectionTitle: {
    color: "#f7f7f7",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 4,
  },
  body: { color: "#c1c1c1", fontSize: 14, lineHeight: 21 },
  details: {
    backgroundColor: "#171717",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
    padding: 13,
  },
  citationRow: { alignItems: "flex-start", flexDirection: "row", gap: 8 },
  detail: { gap: 3 },
  detailLabel: { color: "#858585", fontSize: 11 },
  detailValue: { color: "#f1f1f1", fontSize: 13, lineHeight: 18 },
  caption: { color: "#858585", fontSize: 12, lineHeight: 18 },
  extracted: {
    backgroundColor: "#171717",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    color: "#d1d1d1",
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 19,
    padding: 13,
  },
  markdown: {
    backgroundColor: "#171717",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  empty: {
    alignItems: "center",
    backgroundColor: "#171717",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    padding: 22,
  },
  emptyTitle: { color: "#f7f7f7", fontSize: 16, fontWeight: "700" },
  primary: {
    backgroundColor: "#ff8065",
    borderRadius: 10,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  primaryText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
})
