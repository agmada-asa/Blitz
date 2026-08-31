import { z } from "zod"

export const MAX_FILENAME_LENGTH = 255
export const MAX_SOURCE_TEXT_LENGTH = 120_000
export const CARD_COUNT = 10

const textField = (max: number) => z.string().trim().min(1).max(max)

const commonCard = {
  title: textField(180),
  body: textField(900),
  sourceLabel: textField(180),
}

const explainCard = z.object({
  ...commonCard,
  type: z.literal("explain"),
})

const recallCard = z.object({
  ...commonCard,
  type: z.literal("recall"),
  question: textField(500),
  answer: textField(700),
})

const multipleChoiceCard = z.object({
  ...commonCard,
  type: z.literal("multiple_choice"),
  question: textField(500),
  answer: textField(700),
  options: z.array(textField(300)).length(4),
  correctOption: z.number().int().min(0).max(3),
})

const connectionCard = z.object({
  ...commonCard,
  type: z.literal("connection"),
})

export const cardSchema = z.discriminatedUnion("type", [
  explainCard,
  recallCard,
  multipleChoiceCard,
  connectionCard,
])

export const generationSchema = z
  .object({
    summary: textField(1_000),
    cards: z.array(cardSchema).length(CARD_COUNT),
  })
  .superRefine((value, context) => {
    const counts = value.cards.reduce<Record<string, number>>((all, card) => {
      all[card.type] = (all[card.type] ?? 0) + 1
      return all
    }, {})

    for (const type of ["explain", "recall", "multiple_choice", "connection"]) {
      if ((counts[type] ?? 0) < 2) {
        context.addIssue({
          code: "custom",
          path: ["cards"],
          message: `At least two ${type} cards are required`,
        })
      }
    }
  })

export type Generation = z.infer<typeof generationSchema>

export const codexOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "cards"],
  properties: {
    summary: { type: "string", maxLength: 1000 },
    cards: {
      type: "array",
      minItems: CARD_COUNT,
      maxItems: CARD_COUNT,
      items: { $ref: "#/$defs/card" },
    },
  },
  $defs: {
    card: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "title",
        "body",
        "sourceLabel",
        "question",
        "answer",
        "options",
        "correctOption",
      ],
      properties: {
        type: { enum: ["explain", "recall", "multiple_choice", "connection"] },
        title: { type: "string", minLength: 1, maxLength: 180 },
        body: { type: "string", minLength: 1, maxLength: 900 },
        sourceLabel: { type: "string", minLength: 1, maxLength: 180 },
        question: { type: "string", maxLength: 500 },
        answer: { type: "string", maxLength: 700 },
        options: {
          type: "array",
          minItems: 4,
          maxItems: 4,
          items: { type: "string", maxLength: 300 },
        },
        correctOption: { type: "integer", minimum: 0, maximum: 3 },
      },
    },
  },
} as const
