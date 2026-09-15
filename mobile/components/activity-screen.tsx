/** Renders the native notification center with the web app's bounded activity rows. */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { useCallback, useEffect, useState, type ComponentType } from "react"
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import {
  WebAiSearchIcon,
  WebAlertIcon,
  WebArrowLeftIcon,
  WebChatIcon,
  WebCheckCircleIcon,
  WebDownloadIcon,
  WebFileIcon,
  WebLoadingIcon,
  WebRefreshIcon,
  type WebIconProps,
} from "./web-icon"
import { Text } from "./native-text"
import {
  AccountApiError,
  fetchActivity,
  type MobileActivityRow,
} from "../lib/account-api"

/** Props for the isolated native activity screen. */
export type ActivityScreenProps = {
  readonly serverUrl: string
  readonly onOpen: (href: string) => void
  readonly onClose?: () => void
}

const READ_IDS_KEY = "blitz-mobile-notifications-read-v1"

/** Formats a completed task duration like the web notification center. */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Formats a notification timestamp into the same compact relative labels as the web app. */
function formatTimestamp(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(timestamp)
}

/** Picks a familiar native glyph for one activity kind and status. */
function iconForRow(row: MobileActivityRow): ComponentType<WebIconProps> {
  if (row.status === "failed") return WebAlertIcon
  if (row.status === "completed") return WebCheckCircleIcon
  if (row.status === "running") return WebLoadingIcon
  if (row.kind === "research") return WebAiSearchIcon
  if (row.kind === "import") return WebDownloadIcon
  if (row.kind === "card-reply" || row.kind === "workspace-reply")
    return WebChatIcon
  return WebFileIcon
}

/** Reads locally persisted notification read markers. */
async function readIds(): Promise<Set<string>> {
  try {
    const value = await AsyncStorage.getItem(READ_IDS_KEY)
    const parsed: unknown = value ? JSON.parse(value) : []
    return new Set(
      Array.isArray(parsed)
        ? parsed
            .filter((id): id is string => typeof id === "string")
            .slice(-200)
        : []
    )
  } catch {
    return new Set()
  }
}

/** Renders the activity screen and keeps unread state local to the device. */
export function ActivityScreen({
  serverUrl,
  onOpen,
  onClose,
}: ActivityScreenProps) {
  const insets = useSafeAreaInsets()
  const [snapshot, setSnapshot] =
    useState<Awaited<ReturnType<typeof fetchActivity>>>()
  const [read, setRead] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState("")

  /** Fetches activity and preserves a useful error message for retry. */
  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) setRefreshing(true)
      else setLoading(true)
      setError("")
      try {
        setSnapshot(await fetchActivity(serverUrl))
      } catch (value) {
        setError(
          value instanceof AccountApiError
            ? value.message
            : "Could not load activity"
        )
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [serverUrl]
  )

  useEffect(() => {
    void readIds().then(setRead)
    void load()
  }, [load])

  /** Persists one notification as read before opening its destination. */
  const openRow = useCallback(
    async (row: MobileActivityRow) => {
      if (!read.has(row.id)) {
        const next = new Set(read)
        next.add(row.id)
        setRead(next)
        await AsyncStorage.setItem(
          READ_IDS_KEY,
          JSON.stringify([...next].slice(-200))
        )
      }
      onOpen(row.href)
    },
    [onOpen, read]
  )

  /** Marks every finished notification in the current response as read. */
  const markAllRead = useCallback(async () => {
    if (!snapshot) return
    const next = new Set(read)
    const rows = [...snapshot.notifications, ...snapshot.chatNotifications]
    rows.forEach((row) => next.add(row.id))
    setRead(next)
    await AsyncStorage.setItem(
      READ_IDS_KEY,
      JSON.stringify([...next].slice(-200))
    )
  }, [read, snapshot])

  const unreadCount = [
    ...(snapshot?.notifications ?? []),
    ...(snapshot?.chatNotifications ?? []),
  ].filter((row) => !read.has(row.id)).length

  /** Renders one activity item with a large touch target and destination callback. */
  function renderRow({ item }: { item: MobileActivityRow }) {
    const unread =
      !read.has(item.id) &&
      item.status !== "queued" &&
      item.status !== "running"
    const detail = item.error || item.detail
    const Icon = iconForRow(item)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.title}. ${detail}`}
        onPress={() => void openRow(item)}
        style={({ pressed }) => [
          styles.row,
          unread && styles.unreadRow,
          pressed && styles.pressed,
        ]}
      >
        <View
          style={[
            styles.icon,
            item.status === "failed" && styles.failedIcon,
            unread && styles.brandIcon,
          ]}
        >
          <Icon
            size={18}
            color={
              item.status === "failed"
                ? "#ff6b61"
                : unread
                  ? "#ff8065"
                  : "#aaaaaa"
            }
            strokeWidth={1.8}
          />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowHeading}>
            <Text
              numberOfLines={1}
              style={[styles.rowTitle, unread && styles.unreadTitle]}
            >
              {item.title}
            </Text>
            <Text style={styles.timestamp}>
              {item.status === "running" || item.status === "queued"
                ? formatElapsed(item.elapsedMs)
                : formatTimestamp(item.updatedAt)}
            </Text>
          </View>
          <Text
            numberOfLines={1}
            style={[styles.detail, item.error && styles.error]}
          >
            {item.context ? `${item.context} · ` : ""}
            {detail}
          </Text>
          <Text style={styles.stage}>{item.stage}</Text>
        </View>
        {unread ? <View style={styles.unreadDot} /> : null}
      </Pressable>
    )
  }

  if (loading && !snapshot)
    return (
      <ScreenState
        title="Loading activity"
        loading
        insetBottom={insets.bottom}
      />
    )
  if (error && !snapshot)
    return (
      <ScreenState
        title="Could not load activity"
        message={error}
        onRetry={() => void load()}
        insetBottom={insets.bottom}
      />
    )

  const taskRows = snapshot?.tasks ?? []
  const notificationRows = [
    ...(snapshot?.notifications ?? []),
    ...(snapshot?.chatNotifications ?? []),
  ]
  return (
    <View style={styles.root}>
      <View
        style={[styles.header, { paddingTop: Math.max(insets.top, 12) + 12 }]}
      >
        <View>
          {onClose ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close activity"
              onPress={onClose}
            >
              <WebArrowLeftIcon size={23} color="#ffffff" strokeWidth={1.8} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Activity</Text>
          <Text style={styles.subtitle}>Ongoing work and recent results</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh activity"
          onPress={() => void load(true)}
        >
          <WebRefreshIcon size={22} color="#aaaaaa" strokeWidth={1.8} />
        </Pressable>
      </View>
      <FlatList
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 16) + 76 },
        ]}
        data={notificationRows}
        keyExtractor={(row) => row.id}
        refreshControl={
          <RefreshControl
            onRefresh={() => void load(true)}
            refreshing={refreshing}
            tintColor="#ff8065"
          />
        }
        renderItem={renderRow}
        ListHeaderComponent={
          <>
            <SectionLabel title="Ongoing" count={taskRows.length} />
            <Text style={styles.sectionHint}>
              Work continues when you move elsewhere in Blitz.
            </Text>
            {taskRows.length === 0 ? (
              <EmptyRow text="No work is running right now." />
            ) : null}
            {taskRows.length > 0 ? (
              <View style={styles.group}>
                {taskRows.map((row) => (
                  <View key={row.id}>{renderRow({ item: row })}</View>
                ))}
              </View>
            ) : null}
            <View style={styles.recentHeader}>
              <View>
                <SectionLabel
                  title="Recent"
                  count={unreadCount}
                  countLabel="unread"
                />
                <Text style={styles.sectionHint}>
                  Open a result to return to the relevant place.
                </Text>
              </View>
              {unreadCount > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void markAllRead()}
                >
                  <Text style={styles.action}>Mark all as read</Text>
                </Pressable>
              ) : null}
            </View>
            {notificationRows.length === 0 ? (
              <EmptyRow text="Finished work and replies will appear here." />
            ) : null}
          </>
        }
        ListEmptyComponent={error ? <EmptyRow text={error} /> : null}
      />
    </View>
  )
}

/** Renders a recoverable activity loading or error state. */
function ScreenState({
  title,
  message,
  loading,
  onRetry,
  insetBottom,
}: {
  title: string
  message?: string
  loading?: boolean
  onRetry?: () => void
  insetBottom: number
}) {
  return (
    <View style={[styles.centered, { paddingBottom: insetBottom }]}>
      {loading ? <ActivityIndicator color="#ff8065" /> : null}
      <Text style={styles.title}>{title}</Text>
      {message ? <Text style={styles.body}>{message}</Text> : null}
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={styles.retry}
        >
          <Text style={styles.action}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** Renders a section heading with an optional count. */
function SectionLabel({
  title,
  count,
  countLabel,
}: {
  title: string
  count: number
  countLabel?: string
}) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {count > 0 ? (
        <Text style={styles.count}>
          {count}
          {countLabel ? ` ${countLabel}` : " active"}
        </Text>
      ) : null}
    </View>
  )
}

/** Renders the native empty activity treatment. */
function EmptyRow({ text }: { text: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { backgroundColor: "#101010", flex: 1 },
  header: {
    alignItems: "center",
    borderBottomColor: "#303030",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 16,
  },
  headerCopy: { flex: 1, marginHorizontal: 14 },
  title: { color: "#f7f7f7", fontSize: 25, fontWeight: "600" },
  subtitle: { color: "#aaaaaa", fontSize: 13, marginTop: 4 },
  content: { paddingHorizontal: 16, paddingTop: 24 },
  sectionTitleRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  sectionTitle: { color: "#f7f7f7", fontSize: 19, fontWeight: "600" },
  count: {
    backgroundColor: "#242424",
    borderRadius: 12,
    color: "#aaaaaa",
    fontSize: 11,
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  sectionHint: { color: "#aaaaaa", fontSize: 12, marginTop: 5 },
  group: {
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 12,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    borderBottomColor: "#303030",
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    minHeight: 76,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  unreadRow: { backgroundColor: "rgba(255,128,101,0.06)" },
  pressed: { opacity: 0.7 },
  icon: {
    alignItems: "center",
    backgroundColor: "#242424",
    borderRadius: 9,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  brandIcon: { backgroundColor: "rgba(255,128,101,0.12)" },
  failedIcon: { backgroundColor: "rgba(255,107,97,0.12)" },
  rowBody: { flex: 1, marginLeft: 11, minWidth: 0 },
  rowHeading: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  rowTitle: { color: "#eeeeee", flex: 1, fontSize: 14, fontWeight: "500" },
  unreadTitle: { color: "#ffffff", fontWeight: "700" },
  timestamp: { color: "#888888", fontSize: 11 },
  detail: { color: "#aaaaaa", fontSize: 12, marginTop: 4 },
  stage: { color: "#777777", fontSize: 11, marginTop: 4 },
  error: { color: "#ff6b61" },
  unreadDot: {
    backgroundColor: "#ff8065",
    borderRadius: 4,
    height: 7,
    marginLeft: 8,
    width: 7,
  },
  recentHeader: {
    alignItems: "flex-end",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 30,
  },
  action: { color: "#ff8065", fontSize: 13, fontWeight: "600" },
  empty: {
    borderColor: "#303030",
    borderRadius: 12,
    borderStyle: "dashed",
    borderWidth: 1,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  emptyText: { color: "#aaaaaa", fontSize: 12, textAlign: "center" },
  centered: {
    alignItems: "center",
    backgroundColor: "#101010",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  body: { color: "#aaaaaa", fontSize: 14, lineHeight: 21, textAlign: "center" },
  retry: {
    borderColor: "#444444",
    borderRadius: 9,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
})

export default ActivityScreen
