/**
 * Owns the Android learning feed shell: connection, cached content, paging,
 * filters, and delivery of answer/passive events to the browser service.
 * Server responses remain authoritative for correctness and progress.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Animated,
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

import { FeedBackdrop } from "./components/feed-backdrop"
import {
  BottomNavigation,
  type MobileNavigationKey,
} from "./components/bottom-navigation"
import { ProjectLibrary } from "./components/project-library"
import { useMotionEnabled } from "./lib/use-motion"
import type { ProjectOperation } from "../lib/project-contracts"
import { FilterPanel } from "./components/filter-panel"
import { ChatModal } from "./components/chat-modal"
import { LearningCard } from "./components/learning-card"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { appendFeedPage, filterCards, mergeFeedMetadata } from "./lib/feed"
import {
  chooseFeedDelta,
  clampFeedIndex,
  feedSwipeDirection,
  isFeedAdvanceGesture,
} from "./lib/gesture"
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
  migrateLegacyData,
  orphanLegacyData,
  loadServerUrl,
  removePendingEvent,
  removeProjectEvents,
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

/** Renders the native feed and its small connection and recovery states. */
export default function App() {
  const { height } = useWindowDimensions()
  const motionEnabled = useMotionEnabled()
  const scrollY = useRef(new Animated.Value(0)).current
  const [libraryOpen, setLibraryOpen] = useState(false)
  const insets = useSafeAreaInsets()
  const topInset =
    Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0
  const listRef = useRef<FlatList<MobileLearningCard>>(null)
  const dragStartOffsetRef = useRef(0)
  const dragStartXRef = useRef(0)
  const dragEndXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const dragEndYRef = useRef(0)
  const dragStartIndexRef = useRef(0)
  const pendingSnapTargetRef = useRef<number | null>(null)
  const passiveHandlerRef = useRef<
    (card: MobileLearningCard, type: "skip" | "exposure") => void
  >(() => undefined)
  const [serverUrl, setServerUrl] = useState(configuredServerUrl)
  const [draftServerUrl, setDraftServerUrl] = useState(
    configuredServerUrl ?? ""
  )
  const [editingServerUrl, setEditingServerUrl] = useState(!configuredServerUrl)
  const [connecting, setConnecting] = useState(false)
  const [payload, setPayload] = useState<MobileFeedPayload>()
  const payloadRef = useRef<MobileFeedPayload | undefined>(undefined)
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
  const feedQueryRef = useRef<
    { projectId?: string; topicId?: string } | undefined
  >(undefined)
  const [bootstrapped, setBootstrapped] = useState(false)
  const visibleCards = useMemo(
    () => filterCards(payload, projectId, topicId),
    [payload, projectId, topicId]
  )
  const projects = payload?.projects ?? []
  const topics = payload?.topics ?? []

  /** Loads a local cache before network work so offline prepared material remains usable. */
  const loadCache = useCallback(
    async (server?: string, generation?: number) => {
      const cache = await loadFeedCache(server)
      if (!cache) return false
      if (
        generation !== undefined &&
        generation !== requestGenerationRef.current
      )
        return false
      payloadRef.current = cache.payload
      setPayload(cache.payload)
      // The cache envelope predates persisted query identity; replace it on the
      // first successful refresh instead of mixing pages from an unknown filter.
      feedQueryRef.current = undefined
      setStatus("offline")
      return true
    },
    []
  )

  /** Re-reads the serialized queue so evictions and removals are reflected exactly. */
  const refreshPendingCount = useCallback(async (baseUrl?: string) => {
    try {
      setPendingCount((await loadPendingEvents(baseUrl)).length)
    } catch {
      // Keep the last known count when local storage is temporarily unavailable.
    }
  }, [])

  /** Synchronizes queued events in order and stops at the first unavailable request. */
  const syncPendingEvents = useCallback(
    async (baseUrl: string, generation: number) => {
      const events = await loadPendingEvents(baseUrl)
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
          await removePendingEvent(event.eventId, baseUrl)
          await refreshPendingCount(baseUrl)
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
      pendingSnapTargetRef.current = null
      const generation = requestGenerationRef.current + 1
      requestGenerationRef.current = generation
      requestControllerRef.current?.abort()
      const controller = new AbortController()
      requestControllerRef.current = controller
      if (!baseUrl) {
        try {
          if (!(await loadCache(baseUrl, generation))) {
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
        const sameQuery =
          feedQueryRef.current !== undefined &&
          feedQueryRef.current?.projectId === projectId &&
          feedQueryRef.current?.topicId === topicId
        const mergedPayload =
          sameQuery && payloadRef.current
            ? appendFeedPage(payloadRef.current, nextPayload)
            : mergeFeedMetadata(payloadRef.current, nextPayload)
        payloadRef.current = mergedPayload
        feedQueryRef.current = { projectId, topicId }
        setPayload(mergedPayload)
        if (generation !== requestGenerationRef.current) return
        await saveFeedCache(mergedPayload, baseUrl)
        if (generation !== requestGenerationRef.current) return
        setStatus("ready")
        await syncPendingEvents(baseUrl, generation)
      } catch (requestError) {
        if (generation !== requestGenerationRef.current) return
        let hasCache = Boolean(payloadRef.current)
        if (allowCache && !hasCache) {
          try {
            hasCache = await loadCache(baseUrl, generation)
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
      await saveFeedCache(merged, serverUrl)
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
      let savedUrl: string | undefined
      let effectiveUrl: string | undefined
      try {
        savedUrl = await loadServerUrl()
        effectiveUrl = configuredServerUrl ?? savedUrl
        await migrateLegacyData(savedUrl)
        const pendingEvents = await loadPendingEvents(effectiveUrl)
        if (!configuredServerUrl && savedUrl) {
          setServerUrl(savedUrl)
          setDraftServerUrl(savedUrl)
          setEditingServerUrl(false)
        }
        setPendingCount(pendingEvents.length)
        setFeedback((current) => {
          const next = { ...current }
          for (const event of pendingEvents) {
            if (event.type === "answer")
              next[event.cardId] = { status: "pending" }
          }
          return next
        })
      } catch {
        setError("Could not read saved app data")
        setStatus("error")
      }
      try {
        await loadCache(effectiveUrl)
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
  async function connect() {
    if (!bootstrapped || connecting) return
    const nextUrl = draftServerUrl.trim()
    if (!/^https?:\/\//i.test(nextUrl)) {
      setError("Enter a server URL beginning with http:// or https://")
      return
    }
    setConnecting(true)
    try {
      // Preserve legacy ownership before changing the remembered endpoint.
      await orphanLegacyData()
      await saveServerUrl(nextUrl)
    } catch {
      setError("Could not save this connection. Try again")
      setConnecting(false)
      return
    }
    setConnecting(false)
    setError("")
    setStatus("loading")
    payloadRef.current = undefined
    feedQueryRef.current = undefined
    setPayload(undefined)
    setFeedback({})
    setProjectId(undefined)
    setTopicId(undefined)
    setPendingCount(0)
    requestGenerationRef.current += 1
    requestControllerRef.current?.abort()
    setEditingServerUrl(false)
    if (nextUrl === serverUrl) void refresh(nextUrl)
    else setServerUrl(nextUrl)
  }

  /** Enqueues one event before attempting delivery, preserving it on failure. */
  const recordPassive = useCallback(
    async (card: MobileLearningCard, type: "skip" | "exposure") => {
      let event: Awaited<ReturnType<typeof enqueueEvent>>
      try {
        event = await enqueueEvent(
          card.projectId,
          card.id,
          type,
          undefined,
          serverUrl
        )
      } catch {
        setNotice("Could not save this action. Try again")
        return
      }
      await refreshPendingCount(serverUrl)
      if (!serverUrl) return
      try {
        await submitPassiveEvent(serverUrl, event)
        await removePendingEvent(event.eventId, serverUrl)
        await refreshPendingCount(serverUrl)
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
        answer,
        serverUrl
      )
      setFeedback((current) => ({
        ...current,
        [card.id]: { status: "pending" },
      }))
      await refreshPendingCount(serverUrl)
      if (!serverUrl) {
        setNotice("Answer saved on this device · waiting for sync")
        return
      }
      try {
        const result = await submitAnswer(serverUrl, event)
        await removePendingEvent(event.eventId, serverUrl)
        await refreshPendingCount(serverUrl)
        setFeedback((current) => ({ ...current, [card.id]: result }))
      } catch (requestError) {
        if (
          requestError instanceof MobileApiError &&
          requestError.message.includes("answer response")
        ) {
          try {
            await removePendingEvent(event.eventId, serverUrl)
            await refreshPendingCount(serverUrl)
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

  /** Opens native project management without leaving the learning app. */
  function openLibrary() {
    if (!serverUrl) {
      setNotice("Connect to Blitz to open projects")
      return
    }
    setLibraryOpen(true)
  }

  /** Opens a secondary destination in the browser connected to this native feed. */
  async function openWebRoute(path: string) {
    if (!serverUrl) {
      setNotice("Connect to Blitz to open that page")
      return
    }
    try {
      await Linking.openURL(`${serverUrl.replace(/\/+$/, "")}${path}`)
    } catch {
      setNotice("Could not open that page in your browser")
    }
  }

  /** Handles native tab actions without inventing a second navigation stack. */
  function handleNavigation(key: MobileNavigationKey) {
    if (key === "home") {
      setLibraryOpen(false)
      setFilterOpen(false)
      setChatCard(null)
      return
    }
    if (key === "library") {
      openLibrary()
      return
    }
    void openWebRoute(
      key === "chat" ? "/chat" : key === "activity" ? "/activity" : "/settings"
    )
  }

  /** Invalidates older feed requests and reconciles the device after a confirmed project change. */
  async function projectChanged(operation: ProjectOperation, id: string) {
    requestGenerationRef.current += 1
    requestControllerRef.current?.abort()
    feedQueryRef.current = undefined
    pendingSnapTargetRef.current = null
    const current = payloadRef.current
    if (operation.action === "delete") {
      const next = current
        ? {
            ...current,
            cards: current.cards.filter((card) => card.projectId !== id),
            projects: current.projects.filter((project) => project.id !== id),
            topics: current.topics.filter((topic) => topic.projectId !== id),
            continueCursor: undefined,
          }
        : undefined
      payloadRef.current = next
      setPayload(next)
      if (projectId === id) {
        setProjectId(undefined)
        setTopicId(undefined)
      }
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
      scrollY.setValue(0)
      setActiveIndex(0)
      if (serverUrl) {
        // Deleted-project answers must not block the remaining queue on the next sync.
        await removeProjectEvents(id, serverUrl)
        if (next) await saveFeedCache(next, serverUrl)
        await refreshPendingCount(serverUrl)
      }
    } else if (operation.action === "rename" && current) {
      const next = {
        ...current,
        projects: current.projects.map((project) =>
          project.id === id ? { ...project, title: operation.title } : project
        ),
      }
      payloadRef.current = next
      setPayload(next)
      await saveFeedCache(next, serverUrl)
    }
  }

  /** Opens a project's native feed and discards stale paging metadata. */
  function openProject(id: string) {
    pendingSnapTargetRef.current = null
    requestGenerationRef.current += 1
    requestControllerRef.current?.abort()
    feedQueryRef.current = undefined
    listRef.current?.scrollToOffset({ offset: 0, animated: false })
    scrollY.setValue(0)
    setActiveIndex(0)
    setProjectId(id)
    setTopicId(undefined)
    setLibraryOpen(false)
    if (projectId === id && !topicId) void refresh(serverUrl, false)
  }

  /** Advances to the next card after recording a deliberate skip. */
  function skipCard(card: MobileLearningCard) {
    pendingSnapTargetRef.current = null
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
          placeholder="http://your-computer.local:3001"
          placeholderTextColor="#656565"
          returnKeyType="go"
          style={styles.input}
          value={draftServerUrl}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!bootstrapped || connecting}
          onPress={connect}
          style={styles.primaryButton}
        >
          <Text style={styles.primaryButtonText}>
            {connecting ? "Connecting…" : "Connect"}
          </Text>
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
              placeholder="http://your-computer.local:3001"
              placeholderTextColor="#656565"
              returnKeyType="go"
              style={styles.input}
              value={draftServerUrl}
            />
            <Pressable
              accessibilityRole="button"
              disabled={!bootstrapped || connecting}
              onPress={connect}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>
                {connecting ? "Connecting…" : "Connect"}
              </Text>
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
      <FeedBackdrop
        motionEnabled={
          motionEnabled && !libraryOpen && !filterOpen && !chatCard
        }
      />
      <StatusBar barStyle="light-content" />
      <View
        pointerEvents="box-none"
        style={[
          styles.topControls,
          { paddingTop: 16 + Math.max(topInset, insets.top) },
        ]}
      >
        <View style={styles.topLeft}>
          <Text style={styles.brandText}>Blitz</Text>
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
        <Animated.FlatList
          ref={listRef}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          data={visibleCards}
          decelerationRate="fast"
          disableIntervalMomentum
          getItemLayout={(_, index) => ({
            length: height,
            offset: height * index,
            index,
          })}
          keyExtractor={(card) => card.id}
          onScrollBeginDrag={(event) => {
            pendingSnapTargetRef.current = null
            dragStartOffsetRef.current = event.nativeEvent.contentOffset.y
            dragStartIndexRef.current = Math.round(
              event.nativeEvent.contentOffset.y / height
            )
          }}
          onTouchStart={(event) => {
            pendingSnapTargetRef.current = null
            dragStartXRef.current = event.nativeEvent.pageX
            dragEndXRef.current = event.nativeEvent.pageX
            dragStartYRef.current = event.nativeEvent.pageY
            dragEndYRef.current = event.nativeEvent.pageY
          }}
          onTouchMove={(event) => {
            dragEndXRef.current = event.nativeEvent.pageX
            dragEndYRef.current = event.nativeEvent.pageY
          }}
          onTouchEnd={(event) => {
            dragEndXRef.current = event.nativeEvent.pageX
            dragEndYRef.current = event.nativeEvent.pageY
          }}
          onScrollEndDrag={(event) => {
            const offset = event.nativeEvent.contentOffset.y
            const nativeDeltaY = offset - dragStartOffsetRef.current
            const touchDeltaY = dragStartYRef.current - dragEndYRef.current
            const deltaY = chooseFeedDelta(nativeDeltaY, touchDeltaY)
            const deltaX = dragEndXRef.current - dragStartXRef.current
            const velocityY = event.nativeEvent.velocity?.y ?? 0
            const recognized = isFeedAdvanceGesture({
              deltaX,
              deltaY,
              velocityY,
              height,
            })
            const direction = feedSwipeDirection(deltaY, velocityY)
            const nextIndex = clampFeedIndex(
              dragStartIndexRef.current + direction,
              visibleCards.length
            )
            if (!recognized) return
            if (nextIndex !== dragStartIndexRef.current) {
              pendingSnapTargetRef.current = nextIndex
              requestAnimationFrame(() => {
                if (pendingSnapTargetRef.current !== nextIndex) return
                listRef.current?.scrollToIndex({
                  index: nextIndex,
                  animated: true,
                })
              })
              setActiveIndex(nextIndex)
            }
          }}
          onMomentumScrollEnd={(event) => {
            const target = pendingSnapTargetRef.current
            if (target === null) return
            // Android can emit a second native completion after our animation.
            // Keep this gesture target until the next touch or navigation.
            const actualOffset = event.nativeEvent.contentOffset.y
            const targetOffset = target * height
            if (Math.abs(actualOffset - targetOffset) > 1) {
              listRef.current?.scrollToOffset({
                offset: targetOffset,
                animated: true,
              })
            }
          }}
          onViewableItemsChanged={onViewableItemsChanged}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          snapToAlignment="start"
          snapToInterval={height}
          refreshControl={
            <RefreshControl
              onRefresh={() => void refresh(serverUrl)}
              refreshing={status === "loading"}
              tintColor="#ff8065"
            />
          }
          renderItem={({ item, index }) => (
            <Animated.View
              style={{
                height,
                opacity: motionEnabled
                  ? scrollY.interpolate({
                      inputRange: [
                        (index - 1) * height,
                        index * height,
                        (index + 1) * height,
                      ],
                      outputRange: [0.55, 1, 0.55],
                      extrapolate: "clamp",
                    })
                  : 1,
                transform: [
                  {
                    translateY: motionEnabled
                      ? scrollY.interpolate({
                          inputRange: [
                            (index - 1) * height,
                            index * height,
                            (index + 1) * height,
                          ],
                          outputRange: [24, 0, -24],
                          extrapolate: "clamp",
                        })
                      : 0,
                  },
                ],
              }}
            >
              <LearningCard
                card={item}
                feedback={feedback[item.id]}
                onAnswer={(answer) => recordAnswer(item, answer)}
                onAsk={() => void openChat(item)}
                onSkip={() => skipCard(item)}
              />
            </Animated.View>
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
          style={[styles.notice, { bottom: 84 + insets.bottom }]}
        >
          <Text style={styles.noticeText}>{notice}</Text>
        </Pressable>
      ) : null}
      {libraryOpen && serverUrl && (
        <ProjectLibrary
          serverUrl={serverUrl}
          onClose={() => {
            setLibraryOpen(false)
            void refresh(serverUrl, false)
          }}
          onOpenProject={openProject}
          onChange={projectChanged}
        />
      )}
      <FilterPanel
        open={filterOpen}
        projectId={projectId}
        topicId={topicId}
        projects={projects}
        topics={topics}
        onClose={() => setFilterOpen(false)}
        onSelectProject={(nextId) => {
          pendingSnapTargetRef.current = null
          requestGenerationRef.current += 1
          requestControllerRef.current?.abort()
          listRef.current?.scrollToOffset({ offset: 0, animated: false })
          setStatus("loading")
          setActiveIndex(0)
          setProjectId(nextId)
          setTopicId(undefined)
        }}
        onSelectTopic={(nextId) => {
          pendingSnapTargetRef.current = null
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
      <BottomNavigation
        activeKey={libraryOpen ? "library" : "home"}
        onSelect={handleNavigation}
      />
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
    flex: 1,
    flexShrink: 1,
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  brandText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "600",
  },
  statusText: {
    flexShrink: 1,
    color: "#aaaaaa",
    fontSize: 12,
  },
  filterButton: {
    backgroundColor: "#1b1b1b",
    borderColor: "#303030",
    borderRadius: 20,
    borderWidth: 1,
    minHeight: 44,
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
  footer: {
    paddingVertical: 18,
  },
})
