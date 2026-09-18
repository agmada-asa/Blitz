/** Renders the native card-chat sheet and streams persisted Markdown replies. */

import { useCallback, useEffect, useRef, useState } from "react"
import { randomUUID } from "expo-crypto"
import { useSafeAreaInsets } from "react-native-safe-area-context"
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

import {
  enqueueChatQuestion,
  watchChat,
  retryChatMessage,
  type MobileChatMessage,
  type MobileChatResponse,
} from "../lib/chat"
import { Markdown } from "./markdown"
import { Text, TextInput } from "./native-text"
import { WebCancelIcon } from "./web-icon"
import type { MobileLearningCard } from "../lib/contracts"

/** Props required to attach chat to one feed card. */
export type ChatModalProps = {
  readonly card: MobileLearningCard | null
  readonly serverUrl?: string
  readonly visible: boolean
  readonly onClose: () => void
}

/** Local draft and polling state retained while the sheet is open. */
type ChatState = {
  readonly draft: string
  readonly draftMessageId?: string
  readonly messages: MobileChatMessage[]
  readonly status: MobileChatResponse["status"]
  readonly lastError: string
  readonly requestError: string
  readonly loading: boolean
  readonly sending: boolean
}

/** Empty chat state used until GET returns the selected conversation. */
const EMPTY_STATE: ChatState = {
  draft: "",
  messages: [],
  status: "idle",
  lastError: "",
  requestError: "",
  loading: false,
  sending: false,
}

/** Formats elapsed time from a server timestamp without inventing a completion estimate. */
function formatElapsed(timestamp: number): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - timestamp) / 1_000)
  )
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

/** Shows one feed card's questions and queued server replies in a modal sheet. */
export function ChatModal({
  card,
  serverUrl,
  visible,
  onClose,
}: ChatModalProps) {
  const insets = useSafeAreaInsets()
  const scrollRef = useRef<ScrollView>(null)
  const followReply = useRef(true)
  const cardKey = `${serverUrl}:${card?.projectId}:${card?.id}`
  const [states, setStates] = useState<Record<string, ChatState>>({})
  const state = states[cardKey] ?? EMPTY_STATE

  /** Applies a partial state update without replacing the learner's draft. */
  const updateState = useCallback(
    (update: Partial<ChatState> | ((current: ChatState) => ChatState)) => {
      setStates((all) => {
        const current = all[cardKey] ?? EMPTY_STATE
        return {
          ...all,
          [cardKey]:
            typeof update === "function"
              ? update(current)
              : { ...current, ...update },
        }
      })
    },
    [cardKey]
  )

  /** Subscribes only to the visible card and preserves already received text during reconnects. */
  useEffect(() => {
    if (!visible || !card || !serverUrl) return
    const controller = new AbortController()
    followReply.current = true
    updateState({ loading: true })
    void watchChat(
      serverUrl,
      card,
      controller.signal,
      (next) => {
        updateState({
          messages: next.messages,
          status: next.status,
          lastError: next.lastError ?? "",
          requestError: "",
          loading: false,
        })
      },
      (requestError) => updateState({ loading: false, requestError })
    )
    return () => controller.abort()
  }, [card, serverUrl, visible, updateState])

  /** Queues one question and clears the draft only after the server accepts it. */
  const sendQuestion = useCallback(async () => {
    if (!card || !serverUrl || state.sending) return
    const question = state.draft.trim()
    if (!question) return
    const clientMessageId = state.draftMessageId ?? randomUUID()
    updateState({
      sending: true,
      requestError: "",
      draftMessageId: clientMessageId,
    })
    try {
      const result = await enqueueChatQuestion(
        serverUrl,
        card,
        question,
        clientMessageId
      )
      updateState((current) => {
        const existingIndex = current.messages.findIndex(
          (message) =>
            message.clientMessageId === result.message.clientMessageId
        )
        const messages = [...current.messages]
        if (existingIndex === -1) messages.push(result.message)
        else if (messages[existingIndex].updatedAt <= result.message.updatedAt)
          messages[existingIndex] = result.message
        return {
          ...current,
          messages,
          status: result.message.status === "failed" ? "failed" : "queued",
          lastError: result.message.error ?? "",
          requestError: result.message.error ?? "",
          draft: "",
          draftMessageId: undefined,
          sending: false,
        }
      })
    } catch (error) {
      // Keep both text and ID so a transport retry submits the same message.
      updateState({
        sending: false,
        requestError:
          error instanceof Error ? error.message : "Could not send question.",
      })
    }
  }, [
    card,
    serverUrl,
    state.draft,
    state.draftMessageId,
    state.sending,
    updateState,
  ])

  /** Requeues a failed persisted message through the explicit retry endpoint. */
  const retryMessage = useCallback(
    async (message: MobileChatMessage) => {
      if (!card || !serverUrl || state.sending) return
      updateState({ sending: true, requestError: "" })
      try {
        await retryChatMessage(serverUrl, card, message.id)
        updateState((current) => ({
          ...current,
          messages: current.messages.map((currentMessage) =>
            currentMessage.id === message.id
              ? {
                  ...currentMessage,
                  status: "queued",
                  error: undefined,
                  reply: undefined,
                  updatedAt: Date.now(),
                }
              : currentMessage
          ),
          status: "queued",
          lastError: "",
          sending: false,
        }))
      } catch (error) {
        updateState({
          sending: false,
          requestError:
            error instanceof Error
              ? error.message
              : "Could not retry question.",
        })
      }
    },
    [card, serverUrl, state.sending, updateState]
  )

  /** Updates the draft and starts a fresh stable ID when its text changes. */
  function changeDraft(value: string) {
    updateState({ draft: value, draftMessageId: undefined, requestError: "" })
  }

  /** Closes the modal while the next open will reload server state. */
  function close() {
    onClose()
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={close}
      transparent
      visible={visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.backdrop}
      >
        <View style={styles.sheet}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.heading}>Ask about this card</Text>
              {card ? (
                <Text numberOfLines={2} style={styles.cardTitle}>
                  {card.title}
                </Text>
              ) : null}
            </View>
            <Pressable
              accessibilityLabel="Close chat"
              accessibilityRole="button"
              onPress={close}
              style={styles.closeButton}
            >
              <WebCancelIcon size={20} color="#aaaaaa" strokeWidth={1.8} />
            </Pressable>
          </View>

          <ScrollView
            ref={scrollRef}
            onContentSizeChange={() => {
              if (followReply.current)
                scrollRef.current?.scrollToEnd({ animated: false })
            }}
            onScroll={({ nativeEvent }) => {
              followReply.current =
                nativeEvent.contentSize.height -
                  nativeEvent.contentOffset.y -
                  nativeEvent.layoutMeasurement.height <
                80
            }}
            scrollEventThrottle={32}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
          >
            {state.loading && !state.messages.length ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#ff8065" />
                <Text style={styles.muted}>Loading chat</Text>
              </View>
            ) : null}
            {!state.loading && !state.messages.length ? (
              <Text style={styles.muted}>Ask a question about the card.</Text>
            ) : null}
            {state.messages.map((message) => (
              <View key={message.id} style={styles.messageGroup}>
                <View style={styles.questionBubble}>
                  <Text style={styles.questionText}>{message.question}</Text>
                </View>
                {message.reply ? (
                  <View style={styles.replyBubble}>
                    <Markdown text={message.reply} />
                  </View>
                ) : null}
                {message.status === "queued" ? (
                  <Text style={styles.muted}>
                    Queued · {formatElapsed(message.updatedAt)}
                  </Text>
                ) : null}
                {message.status === "running" ? (
                  <Text style={styles.muted}>
                    {message.reply ? "Replying…" : "Preparing reply…"}
                  </Text>
                ) : null}
                {message.status === "failed" ? (
                  <View style={styles.failedRow}>
                    <Text style={styles.error}>
                      {message.error || "Could not answer that question."}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      disabled={state.sending}
                      onPress={() => void retryMessage(message)}
                      style={styles.retryButton}
                    >
                      <Text style={styles.retryText}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ))}
          </ScrollView>

          <View
            style={[styles.composer, { paddingBottom: 24 + insets.bottom }]}
          >
            <TextInput
              accessibilityLabel="Your question"
              autoCapitalize="sentences"
              multiline
              onChangeText={changeDraft}
              placeholder="Ask a follow-up"
              placeholderTextColor="#656565"
              style={styles.input}
              value={state.draft}
            />
            {state.requestError ? (
              <Text style={styles.error}>{state.requestError}</Text>
            ) : null}
            {!state.requestError &&
            state.lastError &&
            !state.messages.some((message) => message.status === "failed") ? (
              <Text style={styles.error}>{state.lastError}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={!state.draft.trim() || state.sending || !serverUrl}
              onPress={() => void sendQuestion()}
              style={({ pressed }) => [
                styles.sendButton,
                pressed && styles.pressed,
                (!state.draft.trim() || state.sending || !serverUrl) &&
                  styles.disabled,
              ]}
            >
              <Text style={styles.sendText}>
                {state.sending ? "Sending" : "Send question"}
              </Text>
            </Pressable>
            {!serverUrl ? (
              <Text style={styles.error}>
                Connect to Blitz before starting chat.
              </Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.56)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#151515",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: "90%",
    minHeight: "62%",
  },
  header: {
    alignItems: "flex-start",
    borderBottomColor: "#292929",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
  },
  headerCopy: { flex: 1, paddingRight: 12 },
  heading: { color: "#fff", fontSize: 20, fontWeight: "600" },
  cardTitle: { color: "#999", fontSize: 13, lineHeight: 19, marginTop: 8 },
  closeButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  closeText: { color: "#aaa", fontSize: 30, fontWeight: "300", lineHeight: 32 },
  messages: { gap: 16, padding: 22 },
  loadingRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  muted: { color: "#777", fontSize: 13, lineHeight: 20 },
  messageGroup: { gap: 8 },
  questionBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#2a1713",
    borderRadius: 18,
    maxWidth: "92%",
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  questionText: { color: "#f3d8d1", fontSize: 15, lineHeight: 22 },
  replyBubble: {
    alignSelf: "flex-start",
    borderColor: "#303030",
    borderRadius: 18,
    borderWidth: 1,
    maxWidth: "96%",
    paddingHorizontal: 15,
    paddingVertical: 12,
  },
  replyText: { color: "#ddd", fontSize: 15, lineHeight: 23 },
  failedRow: { alignItems: "center", flexDirection: "row", gap: 10 },
  error: { color: "#ff9a89", flex: 1, fontSize: 12, lineHeight: 18 },
  retryButton: {
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 9,
  },
  retryText: { color: "#ffb19e", fontSize: 13, fontWeight: "600" },
  composer: {
    borderTopColor: "#292929",
    borderTopWidth: 1,
    gap: 10,
    padding: 18,
    paddingBottom: 24,
  },
  input: {
    backgroundColor: "#202020",
    borderColor: "#383838",
    borderRadius: 17,
    borderWidth: 1,
    color: "#fff",
    fontSize: 15,
    lineHeight: 21,
    maxHeight: 110,
    minHeight: 54,
    paddingHorizontal: 15,
    paddingVertical: 13,
  },
  sendButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "#ff8065",
    borderRadius: 19,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 18,
  },
  sendText: { color: "#1b0d0a", fontSize: 14, fontWeight: "600" },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.42 },
})
