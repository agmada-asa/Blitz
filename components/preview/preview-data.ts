/** Owns the small local fixture used to exercise the preview feed interactions. */

/** Supported card formats in the visual checkpoint. */
export type PreviewCardType = "explain" | "single_choice" | "multiple_answer"

/** A local learning card with optional answer interaction data. */
export type PreviewCardData = {
  id: string
  type: PreviewCardType
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
    title: "A good mix begins before you touch the EQ.",
    body: "Treat the first reflection points to make your monitoring reference more trustworthy.",
    sourceLabel: "Example · Sound design notes",
  },
  {
    id: "transient-choice",
    type: "single_choice",
    title: "Which move keeps a kick's attack crisp?",
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
    title: "Which moves can push a sound further back?",
    question: "Select all that apply.",
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
