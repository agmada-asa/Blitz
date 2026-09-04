/**
 * Owns the Android learning feed shell: connection, cached content, paging,
 * filters, and delivery of answer/passive events to the browser service.
 * Server responses remain authoritative for correctness and progress.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AppState,
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native"

import { FilterPanel } from "./components/filter-panel"
import { ChatModal } from "./components/chat-modal"
import { LearningCard } from "./components/learning-card"
import {
  MobileApiError,
  fetchFeed,
  submitAnswer,
  submitPassiveEvent,
} from "./lib/api"
import type {
  MobileAnswer,
  MobileAnswerFeedback,
  MobileFeedPayload,
  MobileLearningCard,
} from "./lib/contracts"
import {
  enqueueEvent,
  loadFeedCache,
  loadPendingEvents,
  loadServerUrl,
  removePendingEvent,
  saveFeedCache,
  saveServerUrl,
} from "./lib/storage"

const configuredServerUrl = process.env.EXPO_PUBLIC_BLITZ_URL?.trim()

/** Describes the visible feed data source for status copy. */
type FeedStatus = "loading" | "ready" | "offline" | "error"

/** Returns a readable error while avoiding leaking response content. */
function errorMessage(error: unknown): string {
  return error instanceof MobileApiError
    ? error.message
    : "The learning server is unavailable"
}

/** Returns cards that match the local view of a cached or fetched payload. */
function filterCards(
  payload: MobileFeedPayload | undefined,
  projectId: string | undefined,
  topicId: string | undefined
): MobileLearningCard[] {
  return (payload?.cards ?? []).filter(
    (card) =>
      (!projectId || card.projectId === projectId) &&
      (!topicId || card.topicId === topicId)
  )
}

/** Appends a server page while preserving filter metadata and card order. */
function appendFeedPage(
  current: MobileFeedPayload,
  next: MobileFeedPayload
): MobileFeedPayload {
  const cards = [...current.cards]
  const knownIds = new Set(cards.map((card) => card.id))
  for (const card of next.cards) {
    if (!knownIds.has(card.id)) {
      knownIds.add(card.id)
      cards.push(card)
    }
  }
  const projects = new Map(
    [...current.projects, ...next.projects].map((project) => [
      project.id,
      project,
    ])
  )
  const topics = new Map(
    [...current.topics, ...next.topics].map((topic) => [topic.id, topic])
  )
  return {
    ...next,
    cards,
    projects: [...projects.values()],
    topics: [...topics.values()],
  }
}

/** Merges filter choices while replacing cards for a fresh filter request. */
function mergeFeedMetadata(
  current: MobileFeedPayload | undefined,
  next: MobileFeedPayload
): MobileFeedPayload {
  const projects = new Map(
    [...(current?.projects ?? []), ...next.projects].map((project) => [
      project.id,
      project,
    ])
  )
  const topics = new Map(
    [...(current?.topics ?? []), ...next.topics].map((topic) => [
      topic.id,
      topic,
    ])
  )
  return {
    ...next,
    projects: [...projects.values()],
    topics: [...topics.values()],
  }
}

/** Renders the native feed and its small connection and recovery states. */
export default function App() {
  const { height } = useWindowDimensions()
  const topInset =
    Platform.OS === "android" ? StatusBar.currentHeight ?? 0 : 0
  const listRef = useRef<FlatList<MobileLearningCard>>(null)
  const passiveHandlerRef = useRef<
    (card: MobileLearningCard, type: "skip" | "exposure") => void
  >(() => undefined)
  const [serverUrl, setServerUrl] = useState(configuredServerUrl)
  const [draftServerUrl, setDraftServerUrl] = useState(
    configuredServerUrl ?? ""
  )
  const [editingServerUrl, setEditingServerUrl] = useState(!configuredServerUrl)
  const [payload, setPayload] = useState<MobileFeedPayload>()
  const payloadRef = useRef<MobileFeedPayload | undefined>(undefined)
  const [cacheSavedAt, setCacheSavedAt] = useState<number>()
  const [status, setStatus] = useState<FeedStatus>("loading")
  const [error, setError] = useState("")
  const [projectId, setProjectId] = useState<string>()
  const [topicId, setTopicId] = useState<string>()
  const [filterOpen, setFilterOpen] = useState(false)
  const [feedback, setFeedback] = useState<
    Record<string, MobileAnswerFeedback>
  >({})
  const [pendingCount, setPendingCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [notice, setNotice] = useState("")
  const [chatCard, setChatCard] = useState<MobileLearningCard | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const requestGenerationRef = useRef(0)
  const requestControllerRef = useRef<AbortController | null>(null)
  const [bootstrapped, setBootstrapped] = useState(false)
  const visibleCards = useMemo(
    () => filterCards(payload, projectId, topicId),
    [payload, projectId, topicId]
  )
  const projects = payload?.projects ?? []
  const topics = payload?.topics ?? []

  /** Loads a local cache before network work so offline prepared material remains usable. */
  const loadCache = useCallback(async (generation?: number) => {
    const cache = await loadFeedCache()
    if (!cache) return false
    if (generation !== undefined && generation !== requestGenerationRef.current)
      return false
    payloadRef.current = cache.payload
    setPayload(cache.payload)
    setCacheSavedAt(cache.savedAt)
    setStatus("offline")
    return true
  }, [])

  /** Re-reads the serialized queue so evictions and removals are reflected exactly. */
  const refreshPendingCount = useCallback(async () => {
    try {
      setPendingCount((await loadPendingEvents()).length)
    } catch {
      // Keep the last known count when local storage is temporarily unavailable.
    }
  }, [])

  /** Synchronizes queued events in order and stops at the first unavailable request. */
  const syncPendingEvents = useCallback(
    async (baseUrl: string, generation: number) => {
      const events = await loadPendingEvents()
      if (generation !== requestGenerationRef.current) return
      setPendingCount(events.length)
      for (const event of events) {
        if (generation !== requestGenerationRef.current) return
        try {
          if (event.type === "answer") {
            const result = await submitAnswer(baseUrl, event)
            if (generation !== requestGenerationRef.current) return
            setFeedback((current) => ({ ...current, [event.cardId]: result }))
          } else {
            await submitPassiveEvent(baseUrl, event)
          }
          await removePendingEvent(event.eventId)
          await refreshPendingCount()
        } catch {
          break
        }
      }
    },
    [refreshPendingCount]
  )

  /** Fetches the current feed and preserves a cache when the Mac is unavailable. */
  const refresh = useCallback(
    async (baseUrl: string | undefined, allowCache = true) => {
      const generation = requestGenerationRef.current + 1
      requestGenerationRef.current = generation
      requestControllerRef.current?.abort()
      const controller = new AbortController()
      requestControllerRef.current = controller
      if (!baseUrl) {
        try {
          if (!(await loadCache(generation))) {
            if (generation === requestGenerationRef.current) {
              setStatus("error")
            }
          }
        } catch {
          if (generation === requestGenerationRef.current) {
            setError("Could not read saved feed")
            setStatus("error")
          }
        }
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null
        }
        return
      }
      setStatus("loading")
      setError("")
      try {
        const nextPayload = await fetchFeed(baseUrl, {
          projectId,
          topicId,
          signal: controller.signal,
        })
        if (generation !== requestGenerationRef.current) return
        const mergedPayload = mergeFeedMetadata(payloadRef.current, nextPayload)
        payloadRef.current = mergedPayload
        setPayload(mergedPayload)
        setCacheSavedAt(Date.now())
        if (generation !== requestGenerationRef.current) return
        await saveFeedCache(nextPayload)
        if (generation !== requestGenerationRef.current) return
        setStatus("ready")
        await syncPendingEvents(baseUrl, generation)
      } catch (requestError) {
        if (generation !== requestGenerationRef.current) return
        let hasCache = Boolean(payloadRef.current)
        if (allowCache && !hasCache) {
          try {
            hasCache = await loadCache(generation)
          } catch {
            hasCache = false
          }
        }
        if (generation !== requestGenerationRef.current) return
        setError(errorMessage(requestError))
        setStatus(hasCache ? "offline" : "error")
      } finally {
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null
        }
      }
    },
    [loadCache, projectId, syncPendingEvents, topicId]
  )

  /** Requests the server continuation cursor and appends new cards exactly once. */
  const loadMore = useCallback(async () => {
    const cursor = payload?.continueCursor
    if (!serverUrl || !cursor || loadingMoreRef.current || status === "loading")
      return
    const generation = requestGenerationRef.current
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const nextPage = await fetchFeed(serverUrl, {
        projectId,
        topicId,
        cursor,
        signal: controller.signal,
      })
      if (generation !== requestGenerationRef.current) return
      const current = payload
      const merged = current ? appendFeedPage(current, nextPage) : nextPage
      payloadRef.current = merged
      setPayload((latest) =>
        generation === requestGenerationRef.current &&
        (latest?.continueCursor === cursor || !latest)
          ? merged
          : latest
      )
      if (generation !== requestGenerationRef.current) return
      await saveFeedCache(merged)
    } catch {
      if (generation === requestGenerationRef.current) {
        setNotice("Could not load more cards")
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
      }
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [payload, projectId, serverUrl, status, topicId])

  useEffect(() => {
    /** Restores the configured URL, cache, and queue on first launch. */
    async function bootstrap() {
      try {
        const [savedUrl, pendingEvents] = await Promise.all([
          loadServerUrl(),
          loadPendingEvents(),
        ])
        if (!configuredServerUrl && savedUrl) {
          setServerUrl(savedUrl)
          setDraftServerUrl(savedUrl)
          setEditingServerUrl(false)
        }
        setPendingCount(pendingEvents.length)
        setFeedback((current) => {
          const next = { ...current }
          for (const event of pendingEvents) {
            if (event.type === "answer") next[event.cardId] = { status: "pending" }
          }
          return next
        })
      } catch {
        setError("Could not read saved app data")
        setStatus("error")
      }
      try {
        await loadCache()
      } catch {
        setError("Could not read saved feed")
        setStatus("error")
      } finally {
        setBootstrapped(true)
      }
    }
    void bootstrap()
  }, [loadCache])

  useEffect(() => {
    if (!bootstrapped) return
    void refresh(serverUrl)
  }, [bootstrapped, refresh, serverUrl])

  useEffect(() => {
    /** Refreshes the feed and retries queued events when the app foregrounds. */
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active" && serverUrl) void refresh(serverUrl)
    })
    return () => subscription.remove()
  }, [refresh, serverUrl])

  /** Stores a configured URL and triggers a fresh feed request. */
  function connect() {
    const nextUrl = draftServerUrl.trim()
    if (!/^https?:\/\//i.test(nextUrl)) {
      setError("Enter a server URL beginning with http:// or https://")
      return
    }
    setError("")
    setStatus("loading")
    requestGenerationRef.current += 1
    requestControllerRef.current?.abort()
    setEditingServerUrl(false)
    void saveServerUrl(nextUrl)
    setServerUrl(nextUrl)
  }

  /** Enqueues one event before attempting delivery, preserving it on failure. */
  const recordPassive = useCallback(
    async (card: MobileLearningCard, type: "skip" | "exposure") => {
      let event: Awaited<ReturnType<typeof enqueueEvent>>
      try {
        event = await enqueueEvent(card.projectId, card.id, type)
      } catch {
        setNotice("Could not save this action. Try again")
        return
      }
      await refreshPendingCount()
      if (!serverUrl) return
      try {
        await submitPassiveEvent(serverUrl, event)
        await removePendingEvent(event.eventId)
        await refreshPendingCount()
      } catch {
        setNotice("Saved on this device · waiting for sync")
      }
    },
    [refreshPendingCount, serverUrl]
  )

  useEffect(() => {
    passiveHandlerRef.current = (card, type) => {
      void recordPassive(card, type)
    }
  }, [recordPassive])

  /** Enqueues and submits one answer, showing correctness only when returned by the server. */
  const recordAnswer = useCallback(
    async (card: MobileLearningCard, answer: MobileAnswer) => {
      const event = await enqueueEvent(
        card.projectId,
        card.id,
        "answer",
        answer
      )
      setFeedback((current) => ({
        ...current,
        [card.id]: { status: "pending" },
      }))
      await refreshPendingCount()
      if (!serverUrl) {
        setNotice("Answer saved on this device · waiting for sync")
        return
      }
      try {
        const result = await submitAnswer(serverUrl, event)
        await removePendingEvent(event.eventId)
        await refreshPendingCount()
        setFeedback((current) => ({ ...current, [card.id]: result }))
      } catch (requestError) {
        if (
          requestError instanceof MobileApiError &&
          requestError.message.includes("answer response")
        ) {
          try {
            await removePendingEvent(event.eventId)
            await refreshPendingCount()
          } catch {
            // Preserve the original scoring error for the retryable card state.
          }
          setFeedback((current) => {
            const next = { ...current }
            delete next[card.id]
            return next
          })
          throw requestError
        }
        setNotice("Answer saved on this device · waiting for sync")
      }
    },
    [refreshPendingCount, serverUrl]
  )

  /** Opens the native polling chat sheet for the selected card. */
  const openChat = useCallback(
    (card: MobileLearningCard) => {
      if (!serverUrl) {
        setNotice("Connect to Blitz before starting chat")
        return
      }
      setChatCard(card)
    },
    [serverUrl]
  )

  /** Opens the browser library so source imports remain owned by the web app. */
  const openLibrary = useCallback(async () => {
    if (!serverUrl) {
      setNotice("Connect to Blitz to open the library")
      return
    }
    try {
      await Linking.openURL(`${serverUrl.replace(/\/+$/, "")}/library`)
    } catch {
      setNotice("Could not open the web library")
    }
  }, [serverUrl])

  /** Advances to the next card after recording a deliberate skip. */
  function skipCard(card: MobileLearningCard) {
    const cardFeedback = feedback[card.id]
    const alreadyScored =
      cardFeedback?.status === "correct" || cardFeedback?.status === "incorrect"
    if (!alreadyScored) void recordPassive(card, "skip")
    const nextIndex = activeIndex + 1
    if (nextIndex < visibleCards.length) {
      listRef.current?.scrollToIndex({ index: nextIndex, animated: true })
      setActiveIndex(nextIndex)
    } else {
      setNotice("End of prepared cards")
    }
  }

  /** Tracks the first card visible after a vertical paging gesture and records exposure. */
  const onViewableItemsChanged = useRef(
    ({
      viewableItems,
    }: {
      viewableItems: Array<{ item: MobileLearningCard; index: number | null }>
    }) => {
      const visible = viewableItems[0]
      if (!visible || visible.index === null) return
      setActiveIndex(visible.index)
      passiveHandlerRef.current(visible.item, "exposure")
    }
  ).current

  /** Renders the no-URL connection screen without claiming a live service exists. */
  function renderConnection() {
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>Connect Blitz</Text>
        <Text style={styles.body}>
          Enter the address of the Blitz server on your network.
        </Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onChangeText={setDraftServerUrl}
          onSubmitEditing={connect}
          placeholder="http://your-computer.local:3000"
          placeholderTextColor="#656565"
          returnKeyType="go"
          style={styles.input}
          value={draftServerUrl}
        />
        <Pressable
          accessibilityRole="button"
          onPress={connect}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>Connect</Text>
        </Pressable>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    )
  }

  /** Renders a recoverable loading or error state when no cached feed is available. */
  function renderEmptyState() {
    const title = status === "loading" ? "Loading" : "No prepared cards"
    const message =
      status === "loading"
        ? ""
        : error || "The server has not prepared any cards for this filter."
    const hasMore = Boolean(serverUrl && payload?.continueCursor)
    return (
      <View style={styles.centered}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.body}>{message}</Text> : null}
        {serverUrl && !editingServerUrl ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setEditingServerUrl(true)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Change server</Text>
          </Pressable>
        ) : (
          <>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setDraftServerUrl}
              onSubmitEditing={connect}
              placeholder="http://your-computer.local:3000"
              placeholderTextColor="#656565"
              returnKeyType="go"
              style={styles.input}
              value={draftServerUrl}
            />
            <Pressable
              accessibilityRole="button"
              onPress={connect}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Connect</Text>
            </Pressable>
          </>
        )}
        {hasMore ? (
          <Pressable
            accessibilityRole="button"
            disabled={loadingMore}
            onPress={() => void loadMore()}
            style={[
              styles.secondaryButton,
              loadingMore && styles.buttonDisabled,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              {loadingMore ? "Loading…" : "Load more"}
            </Text>
          </Pressable>
        ) : serverUrl ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh(serverUrl, false)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    )
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View
        pointerEvents="box-none"
        style={[styles.topControls, { paddingTop: 16 + topInset }]}
      >
        <View style={styles.topLeft}>
          <Pressable
            accessibilityRole="link"
            onPress={() => void openLibrary()}
            style={styles.libraryButton}
          >
            <Text style={styles.libraryText}>Library</Text>
          </Pressable>
          <Text style={styles.statusText}>
            {status === "offline"
              ? "Offline · saved cards"
              : pendingCount
                ? `${pendingCount} waiting to sync`
                : ""}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setFilterOpen(true)}
          style={styles.filterButton}
        >
          <Text style={styles.filterText}>Filter</Text>
        </Pressable>
      </View>
      {!serverUrl && status !== "offline" ? (
        renderConnection()
      ) : !visibleCards.length ? (
        renderEmptyState()
      ) : (
        <FlatList
          ref={listRef}
          data={visibleCards}
          decelerationRate="fast"
          getItemLayout={(_, index) => ({
            length: height,
            offset: height * index,
            index,
          })}
          keyExtractor={(card) => card.id}
          onViewableItemsChanged={onViewableItemsChanged}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          pagingEnabled
          refreshControl={
            <RefreshControl
              onRefresh={() => void refresh(serverUrl)}
              refreshing={status === "loading"}
              tintColor="#ff8065"
            />
          }
          renderItem={({ item }) => (
            <View style={{ height }}>
              <LearningCard
                card={item}
                feedback={feedback[item.id]}
                onAnswer={(answer) => recordAnswer(item, answer)}
                onAsk={() => void openChat(item)}
                onSkip={() => skipCard(item)}
              />
            </View>
          )}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color="#ff8065" style={styles.footer} />
            ) : null
          }
          showsVerticalScrollIndicator={false}
        />
      )}
      {notice ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setNotice("")}
          style={styles.notice}
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}
      <FilterPanel
        open={filterOpen}
        projectId={projectId}
        topicId={topicId}
        projects={projects}
        topics={topics}
        onClose={() => setFilterOpen(false)}
        onSelectProject={(nextId) => {
          requestGenerationRef.current += 1
          requestControllerRef.current?.abort()
          listRef.current?.scrollToOffset({ offset: 0, animated: false })
          setStatus("loading")
          setActiveIndex(0)
          setProjectId(nextId)
          setTopicId(undefined)
        }}
        onSelectTopic={(nextId) => {
          requestGenerationRef.current += 1
          requestControllerRef.current?.abort()
          listRef.current?.scrollToOffset({ offset: 0, animated: false })
          setStatus("loading")
          setActiveIndex(0)
          setTopicId(nextId)
        }}
      />
      <ChatModal
        card={chatCard}
        serverUrl={serverUrl}
        visible={chatCard !== null}
        onClose={() => setChatCard(null)}
      />
      {cacheSavedAt && status === "offline" ? (
        <Text accessibilityLiveRegion="polite" style={styles.cacheTime}>
          Saved {new Date(cacheSavedAt).toLocaleTimeString()}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: "#090909",
    flex: 1,
  },
  topControls: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    paddingHorizontal: 18,
    paddingTop: 16,
    position: "absolute",
    right: 0,
    top: 0,
    zIndex: 2,
  },
  topLeft: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  libraryButton: {
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  libraryText: {
    color: "#b0b0b0",
    fontSize: 13,
  },
  statusText: {
    color: "#898989",
    fontSize: 12,
  },
  filterButton: {
    backgroundColor: "#1b1b1b",
    borderColor: "#303030",
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 40,
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  filterText: {
    color: "#dddddd",
    fontSize: 13,
  },
  centered: {
    alignItems: "center",
    backgroundColor: "#090909",
    flex: 1,
    justifyContent: "center",
    padding: 26,
  },
  title: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "600",
    textAlign: "center",
  },
  body: {
    color: "#a6a6a6",
    fontSize: 16,
    lineHeight: 24,
    marginTop: 14,
    maxWidth: 340,
    textAlign: "center",
  },
  input: {
    backgroundColor: "#161616",
    borderColor: "#383838",
    borderRadius: 16,
    borderWidth: 1,
    color: "#ffffff",
    fontSize: 15,
    marginTop: 24,
    minHeight: 52,
    paddingHorizontal: 16,
    width: "100%",
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#ff8065",
    borderRadius: 20,
    justifyContent: "center",
    marginTop: 12,
    minHeight: 48,
    paddingHorizontal: 22,
  },
  primaryButtonText: {
    color: "#1b0d0a",
    fontSize: 14,
    fontWeight: "600",
  },
  secondaryButton: {
    borderColor: "#3a3a3a",
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: "center",
    marginTop: 20,
    minHeight: 46,
    paddingHorizontal: 20,
  },
  secondaryButtonText: {
    color: "#dddddd",
    fontSize: 14,
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  error: {
    color: "#ff9a89",
    fontSize: 13,
    marginTop: 16,
    textAlign: "center",
  },
  notice: {
    alignSelf: "center",
    backgroundColor: "#25201e",
    borderRadius: 16,
    bottom: 22,
    maxWidth: "90%",
    paddingHorizontal: 16,
    paddingVertical: 10,
    position: "absolute",
  },
  noticeText: {
    color: "#ffb19e",
    fontSize: 12,
  },
  cacheTime: {
    bottom: 7,
    color: "#5f5f5f",
    fontSize: 10,
    position: "absolute",
    right: 14,
  },
  footer: {
    paddingVertical: 18,
  },
})
