/** Explicitly exports legacy extracted text into labelled project-local files. */
import { promises as fs } from "node:fs"
import { fileURLToPath } from "node:url"
import { exportLegacyText } from "../lib/server/derived-sources.ts"

/** Shape accepted from an administrator's Convex source export. */
type LegacyRecord = { projectId: string; filename?: string; text: string }

/** Parses and validates a bounded JSON export without inventing source records. */
async function readRecords(path: string): Promise<LegacyRecord[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"))
  if (!Array.isArray(parsed))
    throw new Error("Legacy export must be a JSON array")
  return parsed.map((record, index) => {
    if (!record || typeof record !== "object")
      throw new Error(`Record ${index + 1} is invalid`)
    const value = record as Record<string, unknown>
    const text =
      typeof value.extractedText === "string" ? value.extractedText : value.text
    if (
      typeof value.projectId !== "string" ||
      typeof text !== "string" ||
      !text.trim()
    )
      throw new Error(`Record ${index + 1} needs projectId and non-empty text`)
    return {
      projectId: value.projectId,
      filename: typeof value.filename === "string" ? value.filename : undefined,
      text,
    }
  })
}

/** Runs the explicit legacy export command; writes only when --write is supplied. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const input = argv.find((arg) => !arg.startsWith("--"))
  if (!input)
    throw new Error(
      "Usage: export-legacy-sources <convex-export.json> [--write]"
    )
  const records = await readRecords(input)
  const write = argv.includes("--write")
  for (const record of records) {
    const label = record.filename ?? "legacy source"
    if (write) await exportLegacyText(record.projectId, label, record.text)
    console.log(
      `${write ? "Exported" : "Would export"}: ${record.projectId} / ${label}`
    )
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Legacy export failed"
    )
    process.exitCode = 1
  })
