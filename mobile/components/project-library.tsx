/** Owns native project search and management, including entry to each project workspace. */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import type {
  ProjectOperation,
  ProjectSummary,
} from "../../lib/project-contracts"
import { fetchProjects, updateProject } from "../lib/projects"

/** Inputs connecting the native library to the active feed and saved cache. */
type Props = {
  serverUrl: string
  onClose: () => void
  onOpenProject: (id: string) => void
  onOpenFeed?: (id: string) => void
  onChange: (operation: ProjectOperation, id: string) => Promise<void>
  initialProjectId?: string
  initialMode?: "actions" | "rename" | "delete"
}

/** Renders a full-screen native library with one form at a time and recoverable network errors. */
export function ProjectLibrary({
  serverUrl,
  onClose,
  onOpenProject,
  onOpenFeed,
  onChange,
  initialProjectId,
  initialMode,
}: Props) {
  const insets = useSafeAreaInsets()
  const [projects, setProjects] = useState<ProjectSummary[]>()
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<"newest" | "name">("newest")
  const [mode, setMode] = useState<
    "list" | "actions" | "create" | "rename" | "delete"
  >("list")
  const [selected, setSelected] = useState<ProjectSummary>()
  const [title, setTitle] = useState("")
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(false)
  const initialActionHandled = useRef(false)

  /** Loads current metadata; ignores a response belonging to an unmounted screen. */
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true)
      setError("")
      try {
        const next = await fetchProjects(serverUrl, signal)
        if (!signal?.aborted) setProjects(next)
      } catch (cause) {
        if (!signal?.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load projects. Try again."
          )
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [serverUrl]
  )

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (initialActionHandled.current || !initialProjectId || !projects) return
    const initialProject = projects.find(
      (project) => project.id === initialProjectId
    )
    if (!initialProject) return
    setSelected(initialProject)
    setTitle(initialProject.title)
    setMode(initialMode ?? "actions")
    initialActionHandled.current = true
  }, [initialMode, initialProjectId, projects])

  /** Leaves forms without losing project data; blocks dismissal during an in-flight mutation. */
  function back() {
    if (pending) return
    if (mode === "list") onClose()
    else {
      setMode("list")
      setError("")
    }
  }

  /** Opens a fresh action or edit form for a project. */
  function open(next: typeof mode, project?: ProjectSummary) {
    setSelected(project)
    setTitle(project?.title ?? "")
    setError("")
    setMode(next)
  }

  /** Persists one selected action, then reconciles the library and native cache after server success. */
  async function submit() {
    if (pending) return
    const operation: ProjectOperation | undefined =
      mode === "create"
        ? { action: "create", title: title.trim() }
        : selected && mode === "rename"
          ? { action: "rename", projectId: selected.id, title: title.trim() }
          : selected && mode === "delete"
            ? { action: "delete", projectId: selected.id }
            : undefined
    if (!operation) return
    setPending(true)
    setError("")
    try {
      const id = await updateProject(serverUrl, operation)
      await onChange(operation, id)
      setMode("list")
      setSelected(undefined)
      setSearch("")
      await load()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save the change. Try again."
      )
    } finally {
      setPending(false)
    }
  }

  const filtered = projects
    ?.filter((project) =>
      project.title
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    )
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : b.createdAt - a.createdAt
    )
  const editing = mode === "create" || mode === "rename"

  return (
    <Modal
      visible
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={back}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={[
          styles.root,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
          <Action
            label={mode === "list" ? "Feed" : "Back"}
            onPress={back}
            disabled={pending}
          />
          <Text accessibilityRole="header" style={styles.heading}>
            {mode === "list"
              ? "Projects"
              : mode === "create"
                ? "New project"
                : mode === "rename"
                  ? "Rename project"
                  : mode === "delete"
                    ? "Delete project?"
                    : "Project"}
          </Text>
          {mode === "list" ? (
            <Action label="New project" onPress={() => open("create")} accent />
          ) : (
            <View style={styles.headerSpacer} />
          )}
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {mode === "list" && (
            <>
              {projects && projects.length > 0 && (
                <View style={styles.searchRow}>
                  <TextInput
                    accessibilityLabel="Search projects"
                    value={search}
                    onChangeText={setSearch}
                    placeholder="Search projects…"
                    placeholderTextColor="#999999"
                    style={[styles.input, styles.search]}
                  />
                  <Action
                    label={sort === "newest" ? "Newest first" : "Name A–Z"}
                    onPress={() =>
                      setSort(sort === "newest" ? "name" : "newest")
                    }
                  />
                </View>
              )}
              {loading && (
                <ActivityIndicator
                  accessibilityLabel="Loading projects"
                  color="#ff8065"
                  style={styles.loading}
                />
              )}
              {!loading && projects?.length === 0 && (
                <Text style={styles.empty}>No projects yet</Text>
              )}
              {projects && projects.length > 0 && filtered?.length === 0 && (
                <View style={styles.empty}>
                  <Text style={styles.body}>No matching projects</Text>
                  <Action label="Clear search" onPress={() => setSearch("")} />
                </View>
              )}
              {filtered?.map((project) => (
                <View key={project.id} style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${project.title}`}
                    onPress={() => onOpenProject(project.id)}
                    style={({ pressed }) => [
                      styles.project,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text style={styles.projectTitle}>{project.title}</Text>
                    <Text style={styles.date}>
                      Created{" "}
                      {new Date(project.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        timeZone: "UTC",
                      })}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for ${project.title}`}
                    onPress={() => open("actions", project)}
                    style={styles.more}
                  >
                    <Text style={styles.moreText}>⋯</Text>
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {mode === "actions" && selected && (
            <>
              <Text style={styles.projectHeading}>{selected.title}</Text>
              <Action
                label="Open workspace"
                onPress={() => onOpenProject(selected.id)}
                accent
              />
              <Action
                label="Open feed"
                onPress={() => onOpenFeed?.(selected.id)}
              />
              <Action
                label="Rename project"
                onPress={() => open("rename", selected)}
              />
              <Action
                label="Delete project"
                onPress={() => open("delete", selected)}
                destructive
              />
            </>
          )}
          {editing && (
            <>
              <Text style={styles.label}>Project name</Text>
              <TextInput
                accessibilityLabel="Project name"
                autoFocus
                value={title}
                onChangeText={setTitle}
                editable={!pending}
                maxLength={200}
                onSubmitEditing={() => {
                  if (title.trim()) void submit()
                }}
                returnKeyType="done"
                style={styles.input}
              />
              <Action
                label={
                  pending
                    ? "Saving…"
                    : mode === "create"
                      ? "Create project"
                      : "Save name"
                }
                onPress={() => void submit()}
                accent
                disabled={
                  pending ||
                  !title.trim() ||
                  (mode === "rename" && title.trim() === selected?.title)
                }
              />
            </>
          )}
          {mode === "delete" && selected && (
            <>
              <Text style={styles.body}>
                Delete “{selected.title}” and all its sources, study content,
                conversations, and history? Saved cards and unsynced answers for
                this project will also be removed from this device. This cannot
                be undone.
              </Text>
              <Action label="Cancel" onPress={back} disabled={pending} />
              <Action
                label={pending ? "Deleting…" : "Delete project"}
                onPress={() => void submit()}
                disabled={pending}
                destructive
              />
            </>
          )}
          {error ? (
            <View>
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {error}
              </Text>
              {mode === "list" && (
                <Action
                  label="Refresh projects"
                  onPress={() => void load()}
                  disabled={loading}
                />
              )}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  )
}

/** Renders a text action with a comfortable touch target and visible pressed/disabled states. */
function Action({
  label,
  onPress,
  disabled,
  accent,
  destructive,
}: {
  label: string
  onPress: () => void
  disabled?: boolean
  accent?: boolean
  destructive?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        accent && styles.accent,
        destructive && styles.destructive,
        (disabled || pressed) && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.actionText,
          accent && styles.accentText,
          destructive && styles.destructiveText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  )
}

/** Compact dark native surfaces matching the web library's coral action color. */
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#101010" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  headerSpacer: { width: 44 },
  heading: {
    flex: 1,
    color: "#f7f7f7",
    fontSize: 20,
    fontWeight: "600",
    textAlign: "center",
  },
  content: { padding: 20, gap: 12, paddingBottom: 28 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  search: { flex: 1, minWidth: 0 },
  input: {
    backgroundColor: "#191919",
    borderColor: "#383838",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    minHeight: 48,
    color: "#f7f7f7",
    fontSize: 16,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#191919",
    borderRadius: 12,
  },
  project: { flex: 1, padding: 16, minHeight: 76, justifyContent: "center" },
  projectTitle: { color: "#f7f7f7", fontSize: 16, fontWeight: "500" },
  date: { color: "#aaaaaa", fontSize: 12, marginTop: 5 },
  more: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  moreText: { color: "#aaaaaa", fontSize: 24 },
  projectHeading: {
    color: "#f7f7f7",
    fontSize: 26,
    fontWeight: "600",
    marginBottom: 16,
  },
  body: { color: "#bbbbbb", fontSize: 16, lineHeight: 25 },
  label: { color: "#f7f7f7", fontSize: 14 },
  empty: {
    color: "#aaaaaa",
    textAlign: "center",
    paddingVertical: 24,
    alignItems: "center",
    gap: 12,
  },
  loading: { padding: 20 },
  action: {
    minHeight: 48,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
    borderRadius: 24,
  },
  actionText: { color: "#cccccc", fontSize: 14 },
  accent: { backgroundColor: "#ff8065" },
  accentText: { color: "#1b0d0a", fontWeight: "600" },
  destructive: { backgroundColor: "#3b1919" },
  destructiveText: { color: "#ff9a89" },
  pressed: { opacity: 0.55 },
  error: {
    color: "#ff9a89",
    fontSize: 14,
    lineHeight: 22,
    paddingVertical: 12,
  },
})
