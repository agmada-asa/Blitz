/** Renders the native project detail screen with the web workspace hierarchy. */

import { useEffect, useState } from "react"
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { SourceManagement } from "./source-management"
import { WalkthroughCard } from "./walkthrough-card"
import type { MobileAnswer, MobileAnswerFeedback } from "../lib/contracts"
import type {
  MobileWorkspaceArtifact,
  MobileWorkspaceItem,
  MobileWorkspacePayload,
  MobileWorkspaceSource,
} from "../lib/project-workspace-api"

/** Navigation and URL actions owned by the mobile app shell. */
export type ProjectWorkspaceActions = {
  readonly onBack: () => void
  readonly onStartStudy: () => void
  readonly onStartTest?: () => void
  readonly onStartWrite?: () => void
  readonly onStartTopic?: (topicId: string) => void
  readonly onAnswer?: (
    item: MobileWorkspaceItem,
    answer: MobileAnswer
  ) => Promise<MobileAnswerFeedback>
  readonly onAskItem?: (item: MobileWorkspaceItem) => void
  readonly onOpenChat?: () => void
  readonly onOpenResearch?: () => void
  readonly onOpenSource?: (source: MobileWorkspaceSource) => void
  readonly onOpenArtifact?: (artifact: MobileWorkspaceArtifact) => void
  readonly onUploadFiles?: () => void
  readonly onRefresh?: () => void
  readonly onRenameProject?: () => void
  readonly onDeleteProject?: () => void
}

/** Props for the screen-ready project detail workspace. */
export type ProjectWorkspaceProps = {
  readonly baseUrl: string
  readonly data?: MobileWorkspacePayload
  readonly loading?: boolean
  readonly error?: string
  readonly actions: ProjectWorkspaceActions
}

/** Renders project title, learning overview, sources, files, research, and actions. */
export function ProjectWorkspace({
  baseUrl,
  data,
  loading = false,
  error,
  actions,
}: ProjectWorkspaceProps) {
  const insets = useSafeAreaInsets()
  const [topicLimit, setTopicLimit] = useState(4)
  const [selectedSectionId, setSelectedSectionId] = useState<string>()
  const [focusedConceptId, setFocusedConceptId] = useState<string>()
  const [activeItemIndex, setActiveItemIndex] = useState(0)

  /** Chooses the first unfinished section whenever a different project loads. */
  useEffect(() => {
    if (!data) return
    const defaultSection =
      data.path.sections.find(
        (section) => section.masteredConcepts < section.concepts.length
      ) ?? data.path.sections[0]
    setSelectedSectionId((current) =>
      data.path.sections.some((section) => section.id === current)
        ? current
        : defaultSection?.id
    )
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
    setTopicLimit(4)
  }, [data])

  /** Resets the visible card when the learner changes section or deep dive. */
  useEffect(() => {
    setActiveItemIndex(0)
  }, [focusedConceptId, selectedSectionId])

  if (loading && !data)
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#ff8065" />
        <Text style={styles.muted}>Loading project…</Text>
      </View>
    )
  if (error && !data)
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={actions.onBack} style={styles.secondary}>
          <Text style={styles.secondaryText}>Back to projects</Text>
        </Pressable>
      </View>
    )
  if (!data) return null
  const topics = data.path.sections
  const defaultSection =
    topics.find(
      (section) => section.masteredConcepts < section.concepts.length
    ) ?? topics[0]
  const activeSection =
    topics.find((section) => section.id === selectedSectionId) ?? defaultSection
  const focusedConcept = activeSection?.concepts.find(
    (concept) => concept.id === focusedConceptId
  )
  const deepDiveConcepts = focusedConcept
    ? topics.flatMap((section) =>
        section.concepts.filter(
          (concept) =>
            concept.title.trim().toLocaleLowerCase() ===
            focusedConcept.title.trim().toLocaleLowerCase()
        )
      )
    : []
  const stageItems = (
    focusedConcept ? deepDiveConcepts : (activeSection?.concepts ?? [])
  ).flatMap((concept) => concept.items.map((item) => ({ item, concept })))
  const activeStage = stageItems[activeItemIndex] ?? stageItems[0]
  const currentConcept = activeStage?.concept
  const visibleTopics = topics.slice(0, topicLimit)
  const progress = data.path.stats.conceptCount
    ? Math.round(
        (data.path.stats.masteredConceptCount / data.path.stats.conceptCount) *
          100
      )
    : 0

  /** Selects a section and returns the stage to its complete walkthrough. */
  function selectSection(sectionId: string): void {
    setSelectedSectionId(sectionId)
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
  }

  /** Opens the active concept as the focused deep-dive branch. */
  function openDeepDive(): void {
    if (!currentConcept) return
    setFocusedConceptId(currentConcept.id)
    setActiveItemIndex(0)
  }

  /** Returns from a focused concept branch to its parent section. */
  function closeDeepDive(): void {
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
  }
  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        {
          paddingBottom: Math.max(insets.bottom, 16) + 76,
          paddingTop: insets.top + 12,
        },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to projects"
          onPress={actions.onBack}
          style={styles.back}
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={2}>
          {data.project.title}
        </Text>
        <View style={styles.headerActions}>
          {actions.onRefresh ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Refresh project"
              onPress={actions.onRefresh}
            >
              <Text style={styles.headerActionText}>Refresh</Text>
            </Pressable>
          ) : null}
          {actions.onOpenChat ? (
            <Pressable onPress={actions.onOpenChat}>
              <Text style={styles.headerActionText}>Chat</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={actions.onRenameProject}>
            <Text style={styles.more}>•••</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.pathSection}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Learning path</Text>
          <Text style={styles.muted}>
            {data.path.stats.sectionCount} sections
          </Text>
        </View>
        {topics.length ? (
          <ScrollView
            contentContainerStyle={styles.sectionTabs}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {topics.map((topic, index) => {
              const complete =
                topic.concepts.length > 0 &&
                topic.masteredConcepts === topic.concepts.length
              const selected = topic.id === activeSection?.id
              return (
                <Pressable
                  key={topic.id}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => selectSection(topic.id)}
                  style={[
                    styles.sectionTab,
                    selected && styles.sectionTabSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.sectionTabNumber,
                      selected && styles.sectionTabAccent,
                    ]}
                  >
                    {complete ? "✓" : index + 1}
                  </Text>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.sectionTabText,
                      selected && styles.sectionTabTextSelected,
                    ]}
                  >
                    {topic.title}
                  </Text>
                  {topic.hasNewMaterial ? <View style={styles.newDot} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
        ) : null}
        <View style={styles.stageHeading}>
          <View style={styles.stageHeadingCopy}>
            <Text style={styles.eyebrow}>
              {focusedConcept ? "Deep dive" : "Walkthrough"}
            </Text>
            <Text style={styles.stageTitle} numberOfLines={2}>
              {focusedConcept?.title ?? activeSection?.title ?? "Learning path"}
            </Text>
            <Text style={styles.muted}>
              {focusedConcept
                ? `${deepDiveConcepts.length} matching ${deepDiveConcepts.length === 1 ? "concept" : "concepts"}`
                : activeSection
                  ? `${activeSection.concepts.length} concepts`
                  : "Generated from your sources"}
            </Text>
          </View>
          {focusedConcept ? (
            <Pressable onPress={closeDeepDive} style={styles.secondary}>
              <Text style={styles.secondaryText}>Return</Text>
            </Pressable>
          ) : null}
        </View>
        {activeStage ? (
          <WalkthroughCard
            item={activeStage.item}
            conceptTitle={activeStage.concept.title}
            position={activeItemIndex}
            total={stageItems.length}
            onAnswer={actions.onAnswer}
            onAsk={actions.onAskItem}
            onNext={
              activeItemIndex < stageItems.length - 1
                ? () => setActiveItemIndex((index) => index + 1)
                : undefined
            }
          />
        ) : (
          <View style={styles.emptyStage}>
            <Text style={styles.stageTitle}>Your path is taking shape</Text>
            <Text style={styles.empty}>
              Add source material and Blitz will sort it into topics, concepts,
              walkthroughs, and questions.
            </Text>
            <Pressable onPress={actions.onUploadFiles} style={styles.primary}>
              <Text style={styles.primaryText}>Add sources</Text>
            </Pressable>
          </View>
        )}
        {stageItems.length > 1 ? (
          <View
            style={styles.positionRail}
            accessibilityLabel="Walkthrough position"
          >
            {stageItems.map((stage, index) => (
              <Pressable
                key={stage.item.id}
                accessibilityRole="button"
                accessibilityLabel={`Go to card ${index + 1}: ${stage.item.title}`}
                onPress={() => setActiveItemIndex(index)}
                style={styles.positionButton}
              >
                <View
                  style={[
                    styles.positionMarker,
                    index === activeItemIndex && styles.positionMarkerActive,
                  ]}
                />
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.pathTools}>
          <View style={styles.pathProgressCopy}>
            <Text style={styles.toolLabel}>Progress</Text>
            <Text style={styles.progressValue}>{progress}%</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.muted}>
            {data.path.stats.masteredConceptCount} of{" "}
            {data.path.stats.conceptCount} concepts mastered
          </Text>
          <View style={styles.toolButtons}>
            {focusedConcept ? (
              <Pressable onPress={closeDeepDive} style={styles.secondary}>
                <Text style={styles.secondaryText}>Return to section</Text>
              </Pressable>
            ) : (
              <Pressable
                disabled={!currentConcept}
                onPress={openDeepDive}
                style={[styles.secondary, !currentConcept && styles.disabled]}
              >
                <Text style={styles.secondaryText}>Deep dive</Text>
              </Pressable>
            )}
            <Pressable onPress={actions.onStartStudy} style={styles.secondary}>
              <Text style={styles.secondaryText}>Quick questions</Text>
            </Pressable>
            <Pressable onPress={actions.onUploadFiles} style={styles.secondary}>
              <Text style={styles.secondaryText}>Manage sources</Text>
            </Pressable>
          </View>
          <Text style={styles.toolLabel}>Current concept</Text>
          <Text style={styles.currentConcept}>
            {currentConcept?.title ?? "Choose a section to begin"}
          </Text>
          {currentConcept?.hasNewMaterial ? (
            <Text style={styles.newMaterial}>
              Updated with material from a newer source
            </Text>
          ) : null}
          {currentConcept?.sourceLabels.length ? (
            <Text style={styles.muted}>
              {currentConcept.sourceLabels.join(" · ")}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Learning overview</Text>
        <Text style={styles.heroTitle}>
          Build your way through {data.path.stats.conceptCount} concepts
        </Text>
        <Text style={styles.muted}>
          {data.path.stats.masteredConceptCount} of{" "}
          {data.path.stats.conceptCount} concepts mastered
        </Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress}%` }]} />
        </View>
        <View style={styles.heroActions}>
          <Pressable onPress={actions.onStartStudy} style={styles.primary}>
            <Text style={styles.primaryText}>Start studying</Text>
          </Pressable>
          {actions.onStartTest ? (
            <Pressable onPress={actions.onStartTest} style={styles.secondary}>
              <Text style={styles.secondaryText}>Take a test</Text>
            </Pressable>
          ) : null}
          {actions.onStartWrite ? (
            <Pressable onPress={actions.onStartWrite} style={styles.secondary}>
              <Text style={styles.secondaryText}>Write</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={actions.onOpenResearch} style={styles.secondary}>
            <Text style={styles.secondaryText}>Research</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Topics</Text>
          <Text style={styles.muted}>{data.path.stats.sectionCount}</Text>
        </View>
        {topics.length ? (
          visibleTopics.map((topic, index) => (
            <View key={topic.id} style={styles.topic}>
              <View style={styles.topicNumber}>
                <Text style={styles.topicNumberText}>{index + 1}</Text>
              </View>
              <View style={styles.topicCopy}>
                <Text style={styles.topicTitle}>{topic.title}</Text>
                <Text style={styles.meta}>
                  {topic.masteredConcepts} of {topic.concepts.length} concepts
                </Text>
                {topic.concepts.slice(0, 3).map((concept) => (
                  <Text key={concept.id} style={styles.concept}>
                    • {concept.title}
                  </Text>
                ))}
              </View>
              <Pressable
                onPress={() => actions.onStartTopic?.(topic.id)}
                style={styles.topicAction}
              >
                <Text style={styles.topicActionText}>Start</Text>
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.empty}>
            Study material will appear here after you add a source.
          </Text>
        )}
        {topics.length > topicLimit ? (
          <Pressable onPress={() => setTopicLimit((limit) => limit + 6)}>
            <Text style={styles.linkText}>Show more topics</Text>
          </Pressable>
        ) : null}
      </View>
      <SourceManagement
        baseUrl={baseUrl}
        projectId={data.project.id}
        sources={data.sources}
        ingestion={data.ingestion}
        preparation={data.preparation}
        onOpenSource={actions.onOpenSource}
        onUploadFiles={actions.onUploadFiles}
        onChanged={actions.onRefresh}
      />
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Generated files</Text>
        {data.artifacts.filter((artifact) => artifact.status === "active")
          .length ? (
          data.artifacts
            .filter((artifact) => artifact.status === "active")
            .map((artifact) => (
              <Pressable
                key={artifact.id}
                onPress={() => actions.onOpenArtifact?.(artifact)}
                style={styles.fileRow}
              >
                <Text style={styles.fileIcon}>
                  {artifact.kind === "directory" ? "▱" : "□"}
                </Text>
                <View style={styles.fileCopy}>
                  <Text style={styles.filename} numberOfLines={1}>
                    {artifact.relativeKey}
                  </Text>
                  <Text style={styles.meta}>
                    {artifact.mimeType ?? "Generated file"}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
            ))
        ) : (
          <Text style={styles.empty}>
            Generated files will appear here when the project workspace creates
            them.
          </Text>
        )}
      </View>
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Research</Text>
          {data.research[0] ? (
            <Text style={styles.meta}>{data.research[0].status}</Text>
          ) : null}
        </View>
        {data.research[0] ? (
          <View style={styles.research}>
            <Text style={styles.topicTitle}>{data.research[0].request}</Text>
            {data.research[0].proposal?.topics.slice(0, 6).map((topic) => (
              <Text key={topic} style={styles.concept}>
                • {topic}
              </Text>
            ))}
            {data.research[0].error ? (
              <Text style={styles.error}>{data.research[0].error}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.empty}>
            Research proposals will appear here after you start a research
            request.
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        <Text style={styles.sectionTitle}>Project actions</Text>
        <Pressable onPress={actions.onRenameProject} style={styles.actionRow}>
          <Text style={styles.actionText}>Rename project</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
        <Pressable onPress={actions.onDeleteProject} style={styles.actionRow}>
          <Text style={styles.deleteText}>Delete project</Text>
          <Text style={styles.chevron}>›</Text>
        </Pressable>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: "#101010",
    gap: 26,
    paddingBottom: 42,
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  center: {
    alignItems: "center",
    flex: 1,
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 48,
  },
  back: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    width: 34,
  },
  backText: {
    color: "#f7f7f7",
    fontSize: 36,
    fontWeight: "300",
    lineHeight: 38,
  },
  title: { color: "#f7f7f7", flex: 1, fontSize: 22, fontWeight: "700" },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 18 },
  headerActionText: { color: "#ff8065", fontSize: 14, fontWeight: "700" },
  more: { color: "#aaaaaa", fontSize: 18, letterSpacing: 2 },
  hero: { backgroundColor: "#191919", borderRadius: 20, gap: 10, padding: 20 },
  eyebrow: {
    color: "#aaaaaa",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  heroTitle: {
    color: "#f7f7f7",
    fontSize: 25,
    fontWeight: "700",
    lineHeight: 31,
  },
  muted: { color: "#aaaaaa", fontSize: 13, lineHeight: 19 },
  track: {
    backgroundColor: "#303030",
    borderRadius: 4,
    height: 7,
    marginTop: 5,
    overflow: "hidden",
  },
  fill: { backgroundColor: "#ff8065", borderRadius: 4, height: "100%" },
  heroActions: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginTop: 7 },
  primary: {
    alignItems: "center",
    backgroundColor: "#ff8065",
    borderRadius: 11,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
  secondary: {
    alignItems: "center",
    backgroundColor: "#222222",
    borderColor: "#424242",
    borderRadius: 11,
    borderWidth: 1,
    paddingHorizontal: 15,
    paddingVertical: 11,
  },
  secondaryText: { color: "#f7f7f7", fontSize: 14, fontWeight: "700" },
  pathSection: { gap: 14 },
  sectionTabs: { gap: 8, paddingVertical: 2 },
  sectionTab: {
    alignItems: "center",
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    maxWidth: 220,
    minHeight: 42,
    paddingHorizontal: 11,
  },
  sectionTabSelected: {
    backgroundColor: "#ff806515",
    borderColor: "#ff806566",
  },
  sectionTabNumber: { color: "#858585", fontSize: 12, fontWeight: "700" },
  sectionTabAccent: { color: "#ff8065" },
  sectionTabText: {
    color: "#bdbdbd",
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "600",
  },
  sectionTabTextSelected: { color: "#f7f7f7" },
  newDot: { backgroundColor: "#ff8065", borderRadius: 4, height: 7, width: 7 },
  stageHeading: { alignItems: "flex-end", flexDirection: "row", gap: 12 },
  stageHeadingCopy: { flex: 1, gap: 4 },
  stageTitle: {
    color: "#f7f7f7",
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 27,
  },
  emptyStage: {
    backgroundColor: "#191919",
    borderColor: "#383838",
    borderRadius: 20,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 12,
    padding: 20,
  },
  positionRail: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 2,
    justifyContent: "center",
  },
  positionButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 24,
    paddingHorizontal: 4,
  },
  positionMarker: {
    backgroundColor: "#555555",
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  positionMarkerActive: { backgroundColor: "#ff8065", width: 24 },
  pathTools: {
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 16,
    borderWidth: 1,
    gap: 9,
    padding: 15,
  },
  pathProgressCopy: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  toolLabel: { color: "#f7f7f7", fontSize: 13, fontWeight: "700" },
  progressValue: { color: "#f7f7f7", fontSize: 13, fontWeight: "700" },
  toolButtons: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 3,
  },
  disabled: { opacity: 0.45 },
  currentConcept: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  newMaterial: { color: "#ff8065", fontSize: 12, lineHeight: 18 },
  section: { gap: 12 },
  sectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sectionTitle: { color: "#f7f7f7", fontSize: 20, fontWeight: "700" },
  topic: {
    alignItems: "flex-start",
    borderBottomColor: "#303030",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingBottom: 14,
    paddingTop: 4,
  },
  topicNumber: {
    alignItems: "center",
    borderColor: "#424242",
    borderRadius: 8,
    borderWidth: 1,
    height: 29,
    justifyContent: "center",
    width: 29,
  },
  topicNumberText: { color: "#aaaaaa", fontSize: 13, fontWeight: "700" },
  topicCopy: { flex: 1, gap: 3 },
  topicTitle: { color: "#f7f7f7", fontSize: 16, fontWeight: "700" },
  meta: { color: "#858585", fontSize: 12 },
  concept: { color: "#c1c1c1", fontSize: 13, lineHeight: 19 },
  topicAction: {
    borderColor: "#424242",
    borderRadius: 9,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  topicActionText: { color: "#f7f7f7", fontSize: 12, fontWeight: "700" },
  linkText: { color: "#ff8065", fontSize: 14, fontWeight: "700" },
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
  fileRow: {
    alignItems: "center",
    borderBottomColor: "#303030",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 11,
    paddingVertical: 13,
  },
  fileIcon: { color: "#aaaaaa", fontSize: 22 },
  fileCopy: { flex: 1, gap: 3 },
  filename: { color: "#f7f7f7", fontSize: 14, fontWeight: "600" },
  chevron: { color: "#aaaaaa", fontSize: 25, fontWeight: "300" },
  research: {
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 14,
    borderWidth: 1,
    gap: 6,
    padding: 14,
  },
  actions: {
    borderTopColor: "#303030",
    borderTopWidth: 1,
    gap: 4,
    paddingTop: 20,
  },
  actionRow: {
    alignItems: "center",
    borderBottomColor: "#303030",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 15,
  },
  actionText: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  deleteText: { color: "#ff8c86", fontSize: 15, fontWeight: "600" },
  error: { color: "#ff8c86", fontSize: 14, lineHeight: 20 },
})
