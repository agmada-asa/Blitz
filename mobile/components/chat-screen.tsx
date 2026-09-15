/**
 * Renders the full-screen native workspace chat, including history, project context,
 * streaming Markdown replies, recovery actions, and keyboard-safe composition.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { randomUUID } from "expo-crypto"

import { Markdown } from "./markdown"
import {
  createWorkspaceChat,
  createWorkspaceChatTransport,
  type WorkspaceChat,
  type WorkspaceChatMessage,
  type WorkspaceChatProject,
  type WorkspaceChatTransport,
} from "../lib/workspace-chat"

/** Props for the standalone screen host. */
export type ChatScreenProps = {
  readonly serverUrl?: string
  readonly initialChatId?: string
  readonly initialProject?: WorkspaceChatProject
  readonly transport?: WorkspaceChatTransport
  readonly onClose: () => void
  readonly onNavigate: (destination: "chat-history" | "chat") => void
}

/** Returns a safe error string for UI recovery copy. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Blitz could not finish that reply. Try again."
}

/** Returns the visible title for a saved chat. */
function chatTitle(chat: WorkspaceChat): string {
  const firstUserMessage = chat.messages.find(
    (message) => message.role === "user"
  )
  return chat.title === "New chat" && firstUserMessage
    ? firstUserMessage.content.slice(0, 48)
    : chat.title
}

/** Shows a native full-screen replacement for the web workspace chat page. */
export function ChatScreen({
  serverUrl,
  initialChatId,
  initialProject,
  transport: suppliedTransport,
  onClose,
  onNavigate,
}: ChatScreenProps) {
  const insets = useSafeAreaInsets()
  const listRef = useRef<FlatList<WorkspaceChatMessage>>(null)
  const requestRef = useRef<AbortController | null>(null)
  const [transport] = useState<WorkspaceChatTransport | undefined>(
    () =>
      suppliedTransport ??
      (serverUrl ? createWorkspaceChatTransport(serverUrl) : undefined)
  )
  const [chats, setChats] = useState<WorkspaceChat[]>([])
  const [projects, setProjects] = useState<WorkspaceChatProject[]>([])
  const [activeChat, setActiveChat] = useState<WorkspaceChat>(() =>
    createWorkspaceChat(initialProject)
  )
  const [draft, setDraft] = useState("")
  const [historyOpen, setHistoryOpen] = useState(false)
  const [projectPickerOpen, setProjectPickerOpen] = useState(false)
  const [loading, setLoading] = useState(Boolean(transport))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")

  /** Replaces the active record and writes it to the native history cache. */
  const commitChat = useCallback(
    (next: WorkspaceChat) => {
      setActiveChat(next)
      setChats((current) => [
        next,
        ...current.filter((chat) => chat.id !== next.id),
      ])
      void transport?.saveChat(next)
    },
    [transport]
  )

  /** Loads saved chats and project choices when the screen becomes available. */
  useEffect(() => {
    if (!transport) {
      setLoading(false)
      return
    }
    let cancelled = false
    void Promise.all([
      transport.loadChats(),
      transport.loadProjects(),
      initialChatId && transport.loadChat
        ? transport.loadChat(initialChatId)
        : Promise.resolve(undefined),
    ])
      .then(([savedChats, loadedProjects, requestedRemote]) => {
        if (cancelled) return
        setChats(savedChats)
        setProjects(loadedProjects)
        const requested =
          requestedRemote ??
          (initialChatId
            ? savedChats.find((chat) => chat.id === initialChatId)
            : undefined)
        if (requested) setActiveChat(requested)
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      requestRef.current?.abort()
    }
  }, [initialChatId, transport])

  /** Keeps the latest streamed message visible above the composer. */
  useEffect(() => {
    if (activeChat.messages.length)
      listRef.current?.scrollToEnd({ animated: true })
  }, [activeChat.messages.length, activeChat.messages.at(-1)?.content])

  /** Starts a blank chat and returns focus to the conversation view. */
  const startNewChat = useCallback(() => {
    if (sending) return
    requestRef.current?.abort()
    setActiveChat(createWorkspaceChat())
    setDraft("")
    setError("")
    setHistoryOpen(false)
    setProjectPickerOpen(false)
    onNavigate("chat")
  }, [onNavigate, sending])

  /** Selects a saved transcript from the history drawer. */
  const selectChat = useCallback(
    async (chat: WorkspaceChat) => {
      if (sending) return
      setDraft("")
      setError("")
      setHistoryOpen(false)
      setLoading(true)
      try {
        const loaded =
          chat.messages.length === 0 &&
          !chat.id.startsWith("local-") &&
          transport?.loadChat
            ? await transport.loadChat(chat.id)
            : chat
        setActiveChat(loaded)
      } catch (cause) {
        setError(errorMessage(cause))
      } finally {
        setLoading(false)
      }
      onNavigate("chat")
    },
    [onNavigate, sending, transport]
  )

  /** Attaches one project to the next message, matching the web project context chip. */
  const selectProject = useCallback((project: WorkspaceChatProject) => {
    setActiveChat((current) => ({
      ...current,
      projectId: project.id,
      projectTitle: project.title,
    }))
    setProjectPickerOpen(false)
  }, [])

  /** Sends a new message or retries the latest failed assistant response. */
  const sendMessage = useCallback(
    async (continuationOf?: WorkspaceChatMessage) => {
      if (!transport || sending) return
      const message = draft.trim()
      if (!message && !continuationOf) return
      setSending(true)
      setError("")
      const controller = new AbortController()
      requestRef.current = controller
      const clientMessageId = randomUUID()
      const now = Date.now()
      const userMessage: WorkspaceChatMessage | undefined = continuationOf
        ? undefined
        : {
            id: `local-${clientMessageId}`,
            clientMessageId,
            role: "user",
            content: message,
            status: "completed",
            createdAt: now,
            updatedAt: now,
          }
      const assistantId = `local-assistant-${clientMessageId}`
      let startedChatId = activeChat.id
      let assistantServerId = continuationOf?.serverId ?? continuationOf?.id
      let assistantContent = continuationOf?.content ?? ""
      let latestChat: WorkspaceChat = {
        ...activeChat,
        status: "running",
        updatedAt: now,
        messages: continuationOf
          ? activeChat.messages.map((item) =>
              item.id === continuationOf.id
                ? {
                    ...item,
                    status: "running",
                    error: undefined,
                    updatedAt: now,
                  }
                : item
            )
          : [
              ...activeChat.messages,
              userMessage!,
              {
                id: assistantId,
                clientMessageId,
                role: "assistant",
                content: "",
                status: "running",
                createdAt: now,
                updatedAt: now,
              },
            ],
      }
      setDraft("")
      commitChat(latestChat)
      try {
        await transport.send(
          {
            chatId: activeChat.id.startsWith("local-")
              ? undefined
              : activeChat.id,
            projectIds: activeChat.projectId ? [activeChat.projectId] : [],
            continuationOf: continuationOf?.serverId ?? continuationOf?.id,
            message: continuationOf ? undefined : message,
            clientMessageId,
          },
          controller.signal,
          (event) => {
            if (event.type === "started") {
              startedChatId = event.chatId
              assistantServerId = event.messageId ?? assistantServerId
            } else if (event.type === "delta") {
              assistantContent += event.text
            } else if (event.type === "error") {
              throw new Error(event.message)
            }
            const nextStatus: WorkspaceChatMessage["status"] =
              event.type === "complete" ? "completed" : "running"
            const updatedMessages = latestChat.messages.map((item) => {
              if (
                item.id !== assistantId &&
                item.id !== continuationOf?.id &&
                item.serverId !== continuationOf?.serverId
              )
                return item
              return {
                ...item,
                id: item.id,
                serverId: assistantServerId,
                content: assistantContent,
                status: nextStatus,
                updatedAt: Date.now(),
              }
            })
            latestChat = {
              ...latestChat,
              id: startedChatId,
              status: event.type === "complete" ? "idle" : "running",
              messages: updatedMessages,
              updatedAt: Date.now(),
            }
            commitChat(latestChat)
          }
        )
        commitChat({
          ...latestChat,
          id: startedChatId,
          status: "idle",
          messages: latestChat.messages.map((item) =>
            item.id === assistantId ||
            item.id === continuationOf?.id ||
            item.serverId === continuationOf?.serverId
              ? {
                  ...item,
                  serverId: assistantServerId,
                  content: assistantContent,
                  status: "completed",
                  updatedAt: Date.now(),
                }
              : item
          ),
          updatedAt: Date.now(),
        })
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AbortError") {
          commitChat({
            ...latestChat,
            id: startedChatId,
            status: "failed",
            messages: latestChat.messages.map((item) =>
              item.id === assistantId ||
              item.id === continuationOf?.id ||
              item.serverId === continuationOf?.serverId
                ? {
                    ...item,
                    serverId: assistantServerId,
                    status: "failed",
                    error: "Reply stopped. Try again.",
                    updatedAt: Date.now(),
                  }
                : item
            ),
          })
        } else {
          setError(errorMessage(cause))
          commitChat({
            ...latestChat,
            id: startedChatId,
            status: "failed",
            messages: latestChat.messages.map((item) =>
              item.id === assistantId ||
              item.id === continuationOf?.id ||
              item.serverId === continuationOf?.serverId
                ? {
                    ...item,
                    serverId: assistantServerId,
                    content: assistantContent,
                    status: "failed",
                    error: errorMessage(cause),
                    updatedAt: Date.now(),
                  }
                : item
            ),
          })
        }
      } finally {
        if (requestRef.current === controller) requestRef.current = null
        setSending(false)
      }
    },
    [activeChat, commitChat, draft, sending, transport]
  )

  /** Renders the current transcript row with native Markdown for assistant replies. */
  const renderMessage = useCallback(
    ({ item }: { item: WorkspaceChatMessage }) => {
      const user = item.role === "user"
      const failed = item.status === "failed"
      return (
        <View
          style={[
            styles.messageRow,
            user ? styles.userRow : styles.assistantRow,
          ]}
        >
          <View
            style={[
              styles.message,
              user ? styles.userMessage : styles.assistantMessage,
            ]}
          >
            {user ? (
              <Text selectable style={styles.userText}>
                {item.content}
              </Text>
            ) : item.content ? (
              <Markdown text={item.content} />
            ) : (
              <ActivityIndicator color="#ff8065" />
            )}
            {failed ? (
              <Text style={styles.errorText}>
                {item.error ?? "Blitz could not finish this reply."}
              </Text>
            ) : null}
          </View>
          {failed && !sending ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void sendMessage(item)}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Retry response</Text>
            </Pressable>
          ) : null}
        </View>
      )
    },
    [sendMessage, sending]
  )

  const projectLabel = activeChat.projectTitle ?? "No project"
  const emptyCopy = useMemo(
    () =>
      transport
        ? "Ask Blitz about your material."
        : "Connect Blitz to use workspace chat.",
    [transport]
  )

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.screen}
    >
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close chat"
          onPress={onClose}
          style={styles.headerButton}
        >
          <Text style={styles.headerButtonText}>×</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>Chat</Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {activeChat.projectTitle ?? "Workspace"}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open chat history"
          onPress={() => setHistoryOpen(true)}
          style={styles.headerButton}
        >
          <Text style={styles.headerButtonText}>☰</Text>
        </Pressable>
      </View>
      <View style={styles.contextBar}>
        <Text numberOfLines={1} style={styles.contextText}>
          {projectLabel}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setProjectPickerOpen((open) => !open)}
        >
          <Text style={styles.contextAction}>Attach project</Text>
        </Pressable>
      </View>
      {projectPickerOpen ? (
        <View style={styles.projectPicker}>
          {projects.length ? (
            projects.map((project) => (
              <Pressable
                key={project.id}
                onPress={() => selectProject(project)}
                style={styles.projectRow}
              >
                <Text numberOfLines={1} style={styles.projectText}>
                  {project.title}
                </Text>
              </Pressable>
            ))
          ) : (
            <Text style={styles.muted}>No projects available.</Text>
          )}
        </View>
      ) : null}
      <FlatList
        ref={listRef}
        data={activeChat.messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={[
          styles.transcript,
          !activeChat.messages.length && styles.emptyTranscript,
        ]}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            {loading ? "Loading saved chats…" : emptyCopy}
          </Text>
        }
      />
      <View
        style={[
          styles.composerWrap,
          { paddingBottom: Math.max(insets.bottom, 12) },
        ]}
      >
        <View style={styles.composer}>
          <TextInput
            accessibilityLabel="Message Blitz"
            multiline
            maxLength={4000}
            editable={!sending && Boolean(transport)}
            value={draft}
            onChangeText={setDraft}
            placeholder="Ask Blitz about your material…"
            placeholderTextColor="#858585"
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sending ? "Stop response" : "Send message"}
            disabled={(!draft.trim() && !sending) || !transport}
            onPress={() =>
              sending ? requestRef.current?.abort() : void sendMessage()
            }
            style={[
              styles.sendButton,
              ((!draft.trim() && !sending) || !transport) &&
                styles.disabledButton,
            ]}
          >
            <Text style={styles.sendText}>{sending ? "■" : "↑"}</Text>
          </Pressable>
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : (
          <Text style={styles.disclaimer}>
            Blitz can make mistakes. Check important details against your
            sources.
          </Text>
        )}
      </View>
      {historyOpen ? (
        <View style={[styles.historyOverlay, { paddingTop: insets.top }]}>
          <View style={styles.historyPanel}>
            <View style={styles.historyHeader}>
              <Text style={styles.historyTitle}>Chats</Text>
              <Pressable onPress={startNewChat}>
                <Text style={styles.newText}>＋ New chat</Text>
              </Pressable>
            </View>
            {chats.length ? (
              chats.map((chat) => (
                <Pressable
                  key={chat.id}
                  onPress={() => selectChat(chat)}
                  style={[
                    styles.historyRow,
                    chat.id === activeChat.id && styles.activeHistoryRow,
                  ]}
                >
                  <Text numberOfLines={1} style={styles.historyRowTitle}>
                    {chatTitle(chat)}
                  </Text>
                  <Text numberOfLines={1} style={styles.muted}>
                    {chat.projectTitle ?? "General"}
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text style={styles.muted}>
                Your saved chats will appear here.
              </Text>
            )}
            <Pressable
              onPress={() => setHistoryOpen(false)}
              style={styles.closeHistory}
            >
              <Text style={styles.closeHistoryText}>Back to chat</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0b0b0b" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#ffffff14",
  },
  headerButton: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtonText: { color: "#f1f1f1", fontSize: 26, lineHeight: 30 },
  headerCopy: { flex: 1, alignItems: "center" },
  title: { color: "#f1f1f1", fontSize: 17, fontWeight: "700" },
  subtitle: { color: "#858585", fontSize: 12, marginTop: 2 },
  contextBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#ffffff0d",
  },
  contextText: { flex: 1, color: "#bdbdbd", fontSize: 13 },
  contextAction: { color: "#ff8065", fontSize: 13, fontWeight: "600" },
  projectPicker: {
    marginHorizontal: 16,
    padding: 8,
    backgroundColor: "#171717",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ffffff18",
  },
  projectRow: { padding: 12 },
  projectText: { color: "#f1f1f1", fontSize: 14 },
  transcript: { paddingHorizontal: 18, paddingVertical: 20, gap: 16 },
  emptyTranscript: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: { color: "#858585", fontSize: 15, textAlign: "center" },
  messageRow: { maxWidth: "88%", gap: 5 },
  userRow: { alignSelf: "flex-end", alignItems: "flex-end" },
  assistantRow: { alignSelf: "flex-start", alignItems: "flex-start" },
  message: { borderRadius: 18, paddingHorizontal: 15, paddingVertical: 12 },
  userMessage: { backgroundColor: "#ff8065", borderBottomRightRadius: 5 },
  assistantMessage: {
    backgroundColor: "#141414",
    borderBottomLeftRadius: 5,
    minWidth: 48,
  },
  userText: { color: "#1b0d09", fontSize: 15, lineHeight: 23 },
  retry: { paddingHorizontal: 4, paddingVertical: 5 },
  retryText: { color: "#ff8065", fontSize: 13, fontWeight: "600" },
  composerWrap: { paddingHorizontal: 14, paddingTop: 8 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    backgroundColor: "#171717",
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#ffffff1c",
    padding: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    paddingHorizontal: 10,
    paddingTop: 10,
    color: "#f1f1f1",
    fontSize: 15,
    lineHeight: 22,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#ff8065",
    alignItems: "center",
    justifyContent: "center",
  },
  disabledButton: { opacity: 0.4 },
  sendText: { color: "#1b0d09", fontSize: 22, fontWeight: "800" },
  disclaimer: {
    color: "#707070",
    textAlign: "center",
    fontSize: 10,
    paddingTop: 7,
  },
  errorText: { color: "#ff8c86", fontSize: 12, lineHeight: 18, paddingTop: 7 },
  muted: { color: "#858585", fontSize: 13, lineHeight: 19 },
  historyOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#00000099",
    zIndex: 4,
  },
  historyPanel: {
    flex: 1,
    width: "86%",
    backgroundColor: "#101010",
    padding: 18,
    borderRightWidth: 1,
    borderRightColor: "#ffffff1c",
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 18,
  },
  historyTitle: { color: "#f1f1f1", fontSize: 18, fontWeight: "700" },
  newText: { color: "#ff8065", fontSize: 14, fontWeight: "600" },
  historyRow: {
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 4,
  },
  activeHistoryRow: { backgroundColor: "#ffffff0d" },
  historyRowTitle: {
    color: "#f1f1f1",
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 3,
  },
  closeHistory: {
    marginTop: "auto",
    paddingVertical: 14,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#ffffff14",
  },
  closeHistoryText: { color: "#ff8065", fontSize: 14, fontWeight: "600" },
})
