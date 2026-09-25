/** Names the worker steps shown while a source becomes study material. */

/** Durable steps reported by the content generation worker. */
export type ContentGenerationStage =
  "preparing" | "generating" | "validating" | "importing"

/** Returns short user-facing copy for one worker step. */
export function contentGenerationStageLabel(
  stage: ContentGenerationStage | null | undefined
): string {
  switch (stage) {
    case "preparing":
      return "Reading source and existing lessons"
    case "generating":
      return "Writing lessons and questions"
    case "validating":
      return "Checking generated lessons"
    case "importing":
      return "Adding lessons to your project"
    default:
      return "Preparing source"
  }
}
