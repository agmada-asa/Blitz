/** Owns the small local fixture used to exercise the preview feed interactions. */

/** Supported card formats in the visual checkpoint. */
export type PreviewCardType = "explain" | "single_choice" | "multiple_answer"

/** A local learning card with optional answer interaction data. */
export type PreviewCardData = {
  id: string
  type: PreviewCardType
  label: string
  eyebrow: string
  title: string
  body?: string
  question?: string
  options?: string[]
  correctOption?: number
  correctOptions?: number[]
  answer?: string
  sourceLabel: string
}

/** The three-card sound-design fixture shown by the preview route. */
export const previewCards: PreviewCardData[] = [
  {
    id: "room-treatment",
    type: "explain",
    label: "Explain",
    eyebrow: "01 · Start with the room",
    title: "A good mix begins before you touch the EQ.",
    body: "Room reflections can make a sound feel louder or brighter than it really is. Softening the earliest reflections gives your ears a steadier reference, so later decisions stay intentional.",
    answer:
      "Treat the first reflection points and keep the listening position consistent. You are making the monitoring signal more trustworthy, not trying to make the room completely dead.",
    sourceLabel: "Example · Sound design notes",
  },
  {
    id: "transient-choice",
    type: "single_choice",
    label: "Single choice",
    eyebrow: "02 · Shape a transient",
    title: "Which move keeps a kick's attack crisp?",
    question: "Choose the first move you would try on a crowded low end.",
    options: [
      "Use a short attack on compression",
      "Use a longer attack on compression",
      "Add a steep low-pass filter at 80 Hz",
    ],
    correctOption: 1,
    answer:
      "A longer attack lets the initial transient pass before compression reduces the body.",
    sourceLabel: "Example · Sound design notes",
  },
  {
    id: "space-moves",
    type: "multiple_answer",
    label: "Multiple answer",
    eyebrow: "03 · Create depth",
    title: "Which moves can push a sound further back?",
    question:
      "Select every choice that contributes to a more distant impression.",
    options: [
      "Roll off some high frequencies",
      "Add a little early reflection",
      "Make the dry signal completely mono",
      "Lower the direct signal slightly",
    ],
    correctOptions: [0, 1, 3],
    answer:
      "Less top end, more early reflection, and a quieter direct signal all reduce the sense of proximity.",
    sourceLabel: "Example · Sound design notes",
  },
]
