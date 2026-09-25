/** Renders the native project workspace as the web app's full-screen mobile walkthrough. */

import { useEffect, useState, type ReactNode } from "react"
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { SourceManagement } from "./source-management"
import { Text } from "./native-text"
import { WalkthroughCard } from "./walkthrough-card"
import {
  WebArrowLeftIcon,
  WebArrowRightIcon,
  WebCancelIcon,
  WebCheckIcon,
  WebFileIcon,
  WebFolderIcon,
  WebLayersIcon,
  WebMoreIcon,
  WebSparklesIcon,
} from "./web-icon"
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

/** Identifies the full-screen sheet currently open above the walkthrough. */
type WorkspaceModal = "sections" | "tools" | "sources" | "actions" | null

/** Returns the first section that still has concepts to practice. */
function firstOpenSection(data?: MobileWorkspacePayload) {
  return (
    data?.path.sections.find(
      (section) => section.completedConcepts < section.concepts.length
    ) ?? data?.path.sections[0]
  )
}

/** Renders a compact pill action used in the web workspace header. */
function HeaderPill({
  children,
  icon,
  onPress,
}: {
  readonly children: string
  readonly icon?: ReactNode
  readonly onPress?: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.headerPill, pressed && styles.pressed]}
    >
      <View style={styles.headerPillContent}>
        {icon}
        <Text style={styles.headerPillText}>{children}</Text>
      </View>
    </Pressable>
  )
}

/** Renders the native project learning workspace with modal side-panel equivalents. */
export function ProjectWorkspaceScreen({
  baseUrl,
  data,
  loading = false,
  error,
  actions,
}: ProjectWorkspaceProps) {
  const insets = useSafeAreaInsets()
  const [selectedSectionId, setSelectedSectionId] = useState<string>()
  const [focusedConceptId, setFocusedConceptId] = useState<string>()
  const [activeItemIndex, setActiveItemIndex] = useState(0)
  const [openModal, setOpenModal] = useState<WorkspaceModal>(null)

  /** Selects a valid default section whenever a project response arrives. */
  useEffect(() => {
    if (!data) return
    const defaultSection = firstOpenSection(data)
    setSelectedSectionId((current) =>
      data.path.sections.some((section) => section.id === current)
        ? current
        : defaultSection?.id
    )
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
  }, [data])

  /** Restarts the walkthrough at its first item when its branch changes. */
  useEffect(() => {
    setActiveItemIndex(0)
  }, [focusedConceptId, selectedSectionId])

  if (loading && !data) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color="#ff8065" />
        <Text style={styles.muted}>Loading project…</Text>
      </View>
    )
  }
  if (error && !data) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <Pressable onPress={actions.onBack} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Back to projects</Text>
        </Pressable>
      </View>
    )
  }
  if (!data) return null
  const workspace = data

  const sections = data.path.sections
  const activeSection =
    sections.find((section) => section.id === selectedSectionId) ??
    firstOpenSection(data)
  const focusedConcept = activeSection?.concepts.find(
    (concept) => concept.id === focusedConceptId
  )
  const deepDiveConcepts = focusedConcept
    ? sections.flatMap((section) =>
        section.concepts.filter(
          (concept) =>
            concept.title.trim().toLocaleLowerCase() ===
            focusedConcept.title.trim().toLocaleLowerCase()
        )
      )
    : []
  const stageConcepts = focusedConcept
    ? deepDiveConcepts
    : (activeSection?.concepts ?? [])
  const stageItems = stageConcepts.flatMap((concept) =>
    concept.items.map((item) => ({ item, concept }))
  )
  const activeStage = stageItems[activeItemIndex] ?? stageItems[0]
  const currentConcept = activeStage?.concept
  const progress = data.path.stats.questionCount
    ? Math.round(
        (data.path.stats.answeredQuestionCount /
          data.path.stats.questionCount) *
          100
      )
    : 0
  const activeSources = data.sources.filter(
    (source) => source.status !== "failed"
  )
  const activeArtifacts = data.artifacts.filter(
    (artifact) => artifact.status === "active"
  )

  /** Selects a section and returns the stage to its full walkthrough. */
  function selectSection(sectionId: string): void {
    setSelectedSectionId(sectionId)
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
    setOpenModal(null)
  }

  /** Opens the current concept as a focused deep-dive branch. */
  function openDeepDive(): void {
    if (!currentConcept) return
    setFocusedConceptId(currentConcept.id)
    setActiveItemIndex(0)
    setOpenModal(null)
  }

  /** Returns from a focused concept branch to the selected section. */
  function closeDeepDive(): void {
    setFocusedConceptId(undefined)
    setActiveItemIndex(0)
    setOpenModal(null)
  }

  /** Closes the sheet before running a route or mutation owned by the shell. */
  function closeAndRun(action?: () => void): void {
    setOpenModal(null)
    action?.()
  }

  /** Renders the web workspace's section picker as a native bottom sheet. */
  function renderSectionsSheet(): ReactNode {
    return (
      <Sheet title="Learning path" onClose={() => setOpenModal(null)}>
        <View style={styles.sheetList}>
          {sections.length ? (
            sections.map((section, index) => {
              const complete =
                section.concepts.length > 0 &&
                section.completedConcepts === section.concepts.length
              const selected = section.id === activeSection?.id
              return (
                <Pressable
                  key={section.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => selectSection(section.id)}
                  style={({ pressed }) => [
                    styles.sheetRow,
                    selected && styles.sheetRowSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <View
                    style={[
                      styles.sectionNumber,
                      selected && styles.sectionNumberSelected,
                    ]}
                  >
                    {complete ? (
                      <WebCheckIcon size={16} color="#ff8065" strokeWidth={2} />
                    ) : (
                      <Text
                        style={[
                          styles.sectionNumberText,
                          selected && styles.accentText,
                        ]}
                      >
                        {index + 1}
                      </Text>
                    )}
                  </View>
                  <View style={styles.sheetRowCopy}>
                    <Text style={styles.sheetRowTitle} numberOfLines={1}>
                      {section.title}
                    </Text>
                    <Text style={styles.muted}>
                      {section.completedConcepts} of {section.concepts.length}{" "}
                      concepts completed
                    </Text>
                  </View>
                  {section.hasNewMaterial ? (
                    <View style={styles.newDot} />
                  ) : null}
                </Pressable>
              )
            })
          ) : (
            <Text style={styles.empty}>
              Add source material to build a learning path.
            </Text>
          )}
        </View>
      </Sheet>
    )
  }

  /** Renders the web tools panel and keeps secondary project information reachable. */
  function renderToolsSheet(): ReactNode {
    return (
      <Sheet title="Study tools" onClose={() => setOpenModal(null)}>
        <ScrollView
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.progressHeader}>
            <Text style={styles.sheetSectionTitle}>Progress</Text>
            <Text style={styles.progressValue}>{progress}%</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progress}%` }]} />
          </View>
          <Text style={styles.muted}>
            {workspace.path.stats.questionCount > 0
              ? workspace.path.stats.answeredQuestionCount +
                " of " +
                workspace.path.stats.questionCount +
                " questions answered"
              : "No questions to answer yet"}
          </Text>
          <View style={styles.sheetDivider} />
          <Text style={styles.sheetSectionTitle}>Study tools</Text>
          <View style={styles.sheetActions}>
            {focusedConcept ? (
              <SheetAction label="Return to section" onPress={closeDeepDive} />
            ) : (
              <SheetAction
                label="Deep dive into this concept"
                disabled={!currentConcept}
                onPress={openDeepDive}
              />
            )}
            {activeStage ? (
              <SheetAction
                label="Ask Blitz"
                onPress={() =>
                  closeAndRun(() => actions.onAskItem?.(activeStage.item))
                }
              />
            ) : null}
            <SheetAction
              label="Quick questions"
              onPress={() => closeAndRun(actions.onStartStudy)}
            />
            {actions.onStartTest ? (
              <SheetAction
                label="Take a test"
                onPress={() => closeAndRun(actions.onStartTest)}
              />
            ) : null}
            {actions.onStartWrite ? (
              <SheetAction
                label="Write"
                onPress={() => closeAndRun(actions.onStartWrite)}
              />
            ) : null}
            <SheetAction
              label="Manage sources"
              onPress={() => setOpenModal("sources")}
            />
            {actions.onOpenResearch ? (
              <SheetAction
                label="Research"
                onPress={() => closeAndRun(actions.onOpenResearch)}
              />
            ) : null}
          </View>
          <View style={styles.sheetDivider} />
          <Text style={styles.sheetSectionTitle}>Current concept</Text>
          <Text style={styles.currentConcept}>
            {currentConcept?.title ?? "Choose a section to begin"}
          </Text>
          {currentConcept ? (
            <Text style={styles.muted}>
              {currentConcept.questionCount > 0
                ? currentConcept.answeredQuestionCount +
                  " of " +
                  currentConcept.questionCount +
                  " questions answered"
                : "No questions"}
            </Text>
          ) : null}
          {currentConcept?.hasNewMaterial ? (
            <Text style={styles.accentText}>
              Updated with material from a newer source
            </Text>
          ) : null}
          {currentConcept?.sourceLabels.length ? (
            <Text style={styles.muted}>
              {currentConcept.sourceLabels.join(" · ")}
            </Text>
          ) : null}
          <View style={styles.sheetDivider} />
          <Text style={styles.sheetSectionTitle}>Generated files</Text>
          {activeArtifacts.length ? (
            activeArtifacts.map((artifact) => (
              <Pressable
                key={artifact.id}
                onPress={() =>
                  closeAndRun(() => actions.onOpenArtifact?.(artifact))
                }
                style={styles.fileRow}
              >
                <View style={styles.fileIcon}>
                  {artifact.kind === "directory" ? (
                    <WebFolderIcon
                      size={19}
                      color="#aaaaaa"
                      strokeWidth={1.8}
                    />
                  ) : (
                    <WebFileIcon size={19} color="#aaaaaa" strokeWidth={1.8} />
                  )}
                </View>
                <View style={styles.fileCopy}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {artifact.relativeKey}
                  </Text>
                  <Text style={styles.muted}>
                    {artifact.mimeType ?? "Generated file"}
                  </Text>
                </View>
                <WebArrowRightIcon
                  size={18}
                  color="#aaaaaa"
                  strokeWidth={1.8}
                />
              </Pressable>
            ))
          ) : (
            <Text style={styles.empty}>
              Generated files will appear here when the workspace creates them.
            </Text>
          )}
          <View style={styles.sheetDivider} />
          <Text style={styles.sheetSectionTitle}>Research</Text>
          {workspace.research[0] ? (
            <View style={styles.researchCard}>
              <Text style={styles.sheetRowTitle}>
                {workspace.research[0].request}
              </Text>
              <Text style={styles.muted}>{workspace.research[0].status}</Text>
              {workspace.research[0].proposal?.topics
                .slice(0, 6)
                .map((topic) => (
                  <Text key={topic} style={styles.muted}>
                    • {topic}
                  </Text>
                ))}
            </View>
          ) : (
            <Text style={styles.empty}>
              Research proposals will appear here after you start a request.
            </Text>
          )}
          {loading ? (
            <ActivityIndicator color="#ff8065" style={styles.sheetSpinner} />
          ) : null}
        </ScrollView>
      </Sheet>
    )
  }

  /** Renders source management inside the same sheet family as web dialogs. */
  function renderSourcesSheet(): ReactNode {
    return (
      <Sheet title="Project sources" onClose={() => setOpenModal(null)} wide>
        <ScrollView
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
        >
          <SourceManagement
            baseUrl={baseUrl}
            projectId={workspace.project.id}
            sources={workspace.sources}
            ingestion={workspace.ingestion}
            preparation={workspace.preparation}
            onOpenSource={(source) =>
              closeAndRun(() => actions.onOpenSource?.(source))
            }
            onUploadFiles={() => closeAndRun(actions.onUploadFiles)}
            onChanged={actions.onRefresh}
          />
          {activeSources.length ? (
            <Text style={styles.sheetFootnote}>
              Select a source to open its overview, extracted text, and
              citations.
            </Text>
          ) : null}
        </ScrollView>
      </Sheet>
    )
  }

  /** Renders the project overflow actions behind the web ellipsis button. */
  function renderActionsSheet(): ReactNode {
    return (
      <Sheet title="Project actions" onClose={() => setOpenModal(null)}>
        <View style={styles.sheetActions}>
          {actions.onRefresh ? (
            <SheetAction
              label="Refresh project"
              onPress={() => closeAndRun(actions.onRefresh)}
            />
          ) : null}
          {actions.onRenameProject ? (
            <SheetAction
              label="Rename project"
              onPress={() => closeAndRun(actions.onRenameProject)}
            />
          ) : null}
          {actions.onDeleteProject ? (
            <SheetAction
              label="Delete project"
              destructive
              onPress={() => closeAndRun(actions.onDeleteProject)}
            />
          ) : null}
        </View>
      </Sheet>
    )
  }

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 2 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to projects"
          onPress={actions.onBack}
          style={styles.back}
        >
          <WebArrowLeftIcon size={21} color="#f7f7f7" strokeWidth={1.8} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.headerLabel}>Project</Text>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {data.project.title}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <HeaderPill onPress={actions.onOpenChat}>Chat</HeaderPill>
          <HeaderPill onPress={() => setOpenModal("sources")}>
            Find sources
          </HeaderPill>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Project actions"
            onPress={() => setOpenModal("actions")}
            style={styles.moreButton}
          >
            <WebMoreIcon size={20} color="#aaaaaa" strokeWidth={1.8} />
          </Pressable>
        </View>
      </View>
      <View style={styles.toolbar}>
        <HeaderPill
          icon={<WebLayersIcon size={16} color="#e6e6e6" strokeWidth={1.8} />}
          onPress={() => setOpenModal("sections")}
        >
          Sections
        </HeaderPill>
        <View style={styles.toolbarCopy}>
          <Text style={styles.toolbarTitle} numberOfLines={1}>
            {focusedConcept?.title ?? activeSection?.title ?? "Learning path"}
          </Text>
          <Text style={styles.toolbarSubtitle} numberOfLines={1}>
            {focusedConcept
              ? `Deep dive · ${deepDiveConcepts.length} matching ${deepDiveConcepts.length === 1 ? "concept" : "concepts"}`
              : activeSection
                ? `${activeSection.concepts.length} concepts`
                : "Generated from your sources"}
          </Text>
        </View>
        <HeaderPill
          icon={<WebSparklesIcon size={16} color="#e6e6e6" strokeWidth={1.8} />}
          onPress={() => setOpenModal("tools")}
        >
          Tools
        </HeaderPill>
      </View>
      <View style={styles.stage}>
        {activeStage ? (
          <View style={styles.stageFrame}>
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
          </View>
        ) : (
          <View style={styles.emptyStage}>
            <Text style={styles.emptyStageTitle}>
              Your path is taking shape
            </Text>
            <Text style={styles.emptyStageBody}>
              Add source material and Blitz will sort it into topics, concepts,
              walkthroughs, and questions.
            </Text>
            <Pressable
              onPress={actions.onUploadFiles}
              style={styles.primaryButton}
            >
              <Text style={styles.primaryButtonText}>Add sources</Text>
            </Pressable>
          </View>
        )}
        {stageItems.length > 1 ? (
          <ScrollView
            contentContainerStyle={styles.positionContent}
            showsVerticalScrollIndicator={false}
            style={styles.positionRail}
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
          </ScrollView>
        ) : null}
      </View>
      <Modal
        animationType="slide"
        onRequestClose={() => setOpenModal(null)}
        transparent
        visible={openModal !== null}
      >
        <View style={styles.modalRoot}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close panel"
            onPress={() => setOpenModal(null)}
            style={styles.modalDismiss}
          />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
            {openModal === "sections" ? renderSectionsSheet() : null}
            {openModal === "tools" ? renderToolsSheet() : null}
            {openModal === "sources" ? renderSourcesSheet() : null}
            {openModal === "actions" ? renderActionsSheet() : null}
          </View>
        </View>
      </Modal>
    </View>
  )
}

/** Renders a rounded native sheet with the same modal role as the web panels. */
function Sheet({
  children,
  title,
  onClose,
  wide = false,
}: {
  readonly children: ReactNode
  readonly title: string
  readonly onClose: () => void
  readonly wide?: boolean
}) {
  return (
    <View style={[styles.sheetInner, wide && styles.sheetInnerWide]}>
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
          onPress={onClose}
          style={styles.closeButton}
        >
          <WebCancelIcon size={20} color="#aaaaaa" strokeWidth={1.8} />
        </Pressable>
      </View>
      {children}
    </View>
  )
}

/** Renders one secondary tool action with consistent touch and disabled states. */
function SheetAction({
  label,
  onPress,
  disabled = false,
  destructive = false,
}: {
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly destructive?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.sheetAction,
        destructive && styles.sheetActionDestructive,
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.sheetActionText, destructive && styles.deleteText]}>
        {label}
      </Text>
      <WebArrowRightIcon size={18} color="#aaaaaa" strokeWidth={1.8} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { backgroundColor: "#101010", flex: 1 },
  center: {
    alignItems: "center",
    gap: 12,
    justifyContent: "center",
    padding: 24,
  },
  header: {
    alignItems: "center",
    backgroundColor: "#101010",
    borderBottomColor: "#262626",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 9,
    minHeight: 62,
    paddingBottom: 9,
    paddingHorizontal: 18,
  },
  back: {
    alignItems: "center",
    height: 42,
    justifyContent: "center",
    width: 30,
  },
  headerCopy: { flex: 1, minWidth: 70 },
  headerLabel: { color: "#858585", fontSize: 11, lineHeight: 14 },
  headerTitle: {
    color: "#f7f7f7",
    fontSize: 21,
    fontWeight: "600",
    lineHeight: 25,
  },
  headerActions: { alignItems: "center", flexDirection: "row", gap: 6 },
  headerPill: {
    alignItems: "center",
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 22,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 11,
  },
  headerPillContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  headerPillText: { color: "#e6e6e6", fontSize: 13, fontWeight: "600" },
  moreButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 27,
  },
  toolbar: {
    alignItems: "center",
    backgroundColor: "#101010",
    borderBottomColor: "#262626",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 58,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  toolbarCopy: { flex: 1, minWidth: 0 },
  toolbarTitle: {
    color: "#e6e6e6",
    fontSize: 14,
    fontWeight: "500",
    textAlign: "center",
  },
  toolbarSubtitle: {
    color: "#858585",
    fontSize: 12,
    marginTop: 2,
    textAlign: "center",
  },
  stage: { flex: 1, minHeight: 0, paddingHorizontal: 32, paddingVertical: 18 },
  stageFrame: {
    alignSelf: "center",
    flex: 1,
    justifyContent: "center",
    maxWidth: 760,
    paddingRight: 24,
    width: "100%",
  },
  positionRail: {
    bottom: 18,
    position: "absolute",
    right: 3,
    top: 18,
    width: 26,
  },
  positionContent: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
    paddingVertical: 5,
  },
  positionButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 24,
    width: 26,
  },
  positionMarker: {
    backgroundColor: "#4d4d4d",
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  positionMarkerActive: { backgroundColor: "#ff8065", width: 24 },
  emptyStage: {
    alignSelf: "center",
    backgroundColor: "#191919",
    borderColor: "#383838",
    borderRadius: 24,
    borderStyle: "dashed",
    borderWidth: 1,
    gap: 12,
    maxWidth: 620,
    padding: 24,
    width: "100%",
  },
  emptyStageTitle: { color: "#f7f7f7", fontSize: 24, fontWeight: "700" },
  emptyStageBody: { color: "#aaaaaa", fontSize: 14, lineHeight: 21 },
  primaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "#ff8065",
    borderRadius: 11,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 16,
  },
  primaryButtonText: { color: "#1b0d0a", fontSize: 14, fontWeight: "700" },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: "#222222",
    borderColor: "#424242",
    borderRadius: 11,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 15,
  },
  secondaryButtonText: { color: "#f7f7f7", fontSize: 14, fontWeight: "700" },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.45 },
  muted: { color: "#aaaaaa", fontSize: 13, lineHeight: 19 },
  empty: { color: "#858585", fontSize: 14, lineHeight: 21 },
  error: {
    color: "#ff8c86",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  accentText: { color: "#ff8065", fontSize: 13, lineHeight: 19 },
  modalRoot: {
    backgroundColor: "#00000080",
    flex: 1,
    justifyContent: "flex-end",
  },
  modalDismiss: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  sheet: {
    backgroundColor: "#101010",
    borderColor: "#343434",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    maxHeight: "88%",
    minHeight: 180,
    paddingHorizontal: 18,
    paddingTop: 6,
  },
  sheetInner: { flexShrink: 1, minHeight: 0 },
  sheetInnerWide: { maxHeight: "100%" },
  sheetHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 58,
  },
  sheetTitle: { color: "#f7f7f7", fontSize: 22, fontWeight: "700" },
  closeButton: {
    alignItems: "center",
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  sheetContent: { gap: 12, paddingBottom: 24 },
  sheetList: { gap: 6, paddingBottom: 22 },
  sheetRow: {
    alignItems: "center",
    borderRadius: 13,
    flexDirection: "row",
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 10,
  },
  sheetRowSelected: { backgroundColor: "#ff806514" },
  sectionNumber: {
    alignItems: "center",
    borderColor: "#424242",
    borderRadius: 8,
    borderWidth: 1,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  sectionNumberSelected: { borderColor: "#ff806566" },
  sectionNumberText: { color: "#858585", fontSize: 13, fontWeight: "700" },
  sheetRowCopy: { flex: 1, gap: 3 },
  sheetRowTitle: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  newDot: { backgroundColor: "#ff8065", borderRadius: 4, height: 8, width: 8 },
  progressHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sheetSectionTitle: { color: "#f7f7f7", fontSize: 18, fontWeight: "700" },
  progressValue: { color: "#f7f7f7", fontSize: 14, fontWeight: "700" },
  track: {
    backgroundColor: "#303030",
    borderRadius: 4,
    height: 7,
    overflow: "hidden",
  },
  fill: { backgroundColor: "#ff8065", borderRadius: 4, height: "100%" },
  sheetDivider: { backgroundColor: "#303030", height: 1, marginVertical: 7 },
  sheetActions: { gap: 7 },
  sheetAction: {
    alignItems: "center",
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 14,
  },
  sheetActionDestructive: { borderColor: "#6c3737" },
  sheetActionText: {
    color: "#f7f7f7",
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  deleteText: { color: "#ff8c86" },
  currentConcept: { color: "#f7f7f7", fontSize: 15, fontWeight: "600" },
  fileRow: {
    alignItems: "center",
    borderBottomColor: "#303030",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingVertical: 11,
  },
  fileIcon: { alignItems: "center", justifyContent: "center", width: 22 },
  fileCopy: { flex: 1, gap: 3 },
  fileName: { color: "#f7f7f7", fontSize: 14, fontWeight: "600" },
  researchCard: {
    backgroundColor: "#191919",
    borderColor: "#303030",
    borderRadius: 13,
    borderWidth: 1,
    gap: 5,
    padding: 13,
  },
  sheetSpinner: { marginVertical: 10 },
  sheetFootnote: {
    color: "#858585",
    fontSize: 12,
    lineHeight: 18,
    paddingTop: 4,
  },
})
