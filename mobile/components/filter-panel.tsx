/**
 * Provides the compact project and topic filter controls shown above the
 * native feed. It uses a modal so the feed itself keeps the full-screen focus.
 */

import { Modal, Pressable, StyleSheet, Text, View } from "react-native"

import type { MobileProjectChoice, MobileTopicChoice } from "../lib/contracts"

/** Props for opening, rendering, and applying the feed filters. */
export type FilterPanelProps = {
  readonly open: boolean
  readonly projectId?: string
  readonly topicId?: string
  readonly projects: readonly MobileProjectChoice[]
  readonly topics: readonly MobileTopicChoice[]
  readonly onClose: () => void
  readonly onSelectProject: (id?: string) => void
  readonly onSelectTopic: (id?: string) => void
}

/** Renders filter choices and closes after each selection. */
export function FilterPanel({
  open,
  projectId,
  topicId,
  projects,
  topics,
  onClose,
  onSelectProject,
  onSelectTopic,
}: FilterPanelProps) {
  return (
    <Modal
      animationType="fade"
      transparent
      visible={open}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Filter</Text>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.close}
            >
              <Text style={styles.closeText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.label}>Project</Text>
          <View style={styles.choices}>
            <FilterChoice
              label="All projects"
              selected={!projectId}
              onPress={() => {
                onSelectProject(undefined)
                onClose()
              }}
            />
            {projects.map((choice) => (
              <FilterChoice
                key={choice.id}
                label={choice.title}
                selected={projectId === choice.id}
                onPress={() => {
                  onSelectProject(choice.id)
                  onClose()
                }}
              />
            ))}
          </View>
          <Text style={styles.label}>Topic</Text>
          <View style={styles.choices}>
            <FilterChoice
              label="All topics"
              selected={!topicId}
              onPress={() => {
                onSelectTopic(undefined)
                onClose()
              }}
            />
            {topics
              .filter((choice) => !projectId || choice.projectId === projectId)
              .map((choice) => (
                <FilterChoice
                  key={choice.id}
                  label={choice.title}
                  selected={topicId === choice.id}
                  onPress={() => {
                    onSelectTopic(choice.id)
                    onClose()
                  }}
                />
              ))}
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** Renders one accessible radio-like filter choice. */
function FilterChoice({
  label,
  selected,
  onPress,
}: {
  readonly label: string
  readonly selected: boolean
  readonly onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
      ]}
    >
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0, 0, 0, 0.74)",
    flex: 1,
    justifyContent: "flex-end",
  },
  panel: {
    backgroundColor: "#171717",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    paddingBottom: 34,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 22,
  },
  title: {
    color: "#ffffff",
    fontSize: 22,
    fontWeight: "600",
  },
  close: {
    minHeight: 42,
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  closeText: {
    color: "#b0b0b0",
    fontSize: 14,
  },
  label: {
    color: "#777777",
    fontSize: 12,
    marginBottom: 8,
    marginTop: 12,
    textTransform: "uppercase",
  },
  choices: {
    gap: 8,
  },
  choice: {
    backgroundColor: "#222222",
    borderColor: "#303030",
    borderRadius: 15,
    borderWidth: 1,
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: 15,
  },
  choiceSelected: {
    backgroundColor: "#2a1713",
    borderColor: "#ff8065",
  },
  choicePressed: {
    opacity: 0.76,
  },
  choiceText: {
    color: "#d0d0d0",
    fontSize: 14,
  },
  choiceTextSelected: {
    color: "#ffb19e",
    fontWeight: "600",
  },
})
