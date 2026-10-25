/**
 * Small builders for the JSON Schemas that background generation sends with its
 * turns, so Codex and Claude Code reply in a checked shape instead of free
 * text that has to be fished for JSON.
 *
 * Codex sends the schema to the model in strict mode, which accepts only a
 * subset of JSON Schema: every object must list all of its properties as
 * required and forbid extra ones, optional values are written as a union with
 * `null`, and keywords such as `minLength` are rejected outright. Claude Code
 * accepts that subset too, so one schema serves both. The helpers here only
 * produce that subset; the schemas fix the shape, and the existing parsers in
 * `lib/exam.ts`, `lib/practice.ts` and the audio script writers still check
 * the content before anything is saved.
 */

/** One JSON Schema node, as sent to the provider. */
export type JsonSchema = Record<string, unknown>

/**
 * An object whose listed properties are all required and which allows no
 * others, as strict mode demands.
 * @param properties Property schemas by name. Use `nullable` for optional ones.
 */
export function strictObject(properties: Record<string, JsonSchema>): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  }
}

/**
 * A value that may also be `null`: how strict mode spells an optional field.
 * @param schema Schema of the value when present.
 */
export function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: "null" }] }
}

/** A string. */
export const STRING: JsonSchema = { type: "string" }

/** Any JSON number. */
export const NUMBER: JsonSchema = { type: "number" }

/** A whole number. */
export const INTEGER: JsonSchema = { type: "integer" }

/** A boolean. */
export const BOOLEAN: JsonSchema = { type: "boolean" }

/**
 * An array of one item shape.
 * @param items Schema every element must match.
 */
export function arrayOf(items: JsonSchema): JsonSchema {
  return { type: "array", items }
}

/**
 * A string limited to the listed values.
 * @param values Allowed values.
 */
export function oneOfStrings(values: readonly string[]): JsonSchema {
  return { type: "string", enum: [...values] }
}

/**
 * A value matching any one of the given shapes.
 * @param schemas Alternatives; strict mode accepts `anyOf` below the root.
 */
export function anyOf(...schemas: JsonSchema[]): JsonSchema {
  return { anyOf: schemas }
}
