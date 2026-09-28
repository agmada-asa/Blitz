/**
 * Measures what source preparation keeps from real course files.
 *
 * Reads a local suite manifest, runs each file through the same extraction,
 * persistence bound and sectioning as desktop uploads, and reports whether
 * the file would reach generation with sections, how dense its pages are and
 * how cleanly it is split. Nothing is sent to a model or saved to Convex.
 * The JSON report goes to the gitignored `.eval/` directory and never
 * contains source text.
 *
 * Usage: npm run eval:ingestion -- [--manifest path] [--suite id]
 */

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SourceIngestionError } from "../lib/server/source-ingestion/errors.ts"
import {
  extractNormalizedStoredSource,
  segmentPreparedDocument,
} from "../lib/server/source-ingestion/prepare.ts"
import {
  measurePageDensity,
  measureSectionQuality,
  type PageDensity,
  type SectionQuality,
} from "../lib/evals/ingestion-metrics.ts"

/** Repository root, used to resolve the default manifest and report paths. */
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url))

/** Default manifest location. The file is gitignored because it names personal files. */
const DEFAULT_MANIFEST = join(REPOSITORY_ROOT, "evals", "suites.local.json")

/** File extensions desktop uploads can extract. Others are skipped. */
const SUPPORTED_EXTENSIONS = /\.(pdf|md|markdown|txt|pptx|html?)$/i

/** One group of files that is uploaded together in an eval run. */
interface EvalSuite {
  /** Stable kebab-case ID used on the command line and in reports. */
  id: string
  /** What product behavior the suite exercises. */
  description: string
  /** Files or directories relative to the manifest root. Directories are not recursive. */
  paths: string[]
  /** File names to leave out, such as personal documents in a module folder. */
  exclude?: string[]
  /** File names that are supporting reference material rather than taught material. */
  reference?: string[]
}

/** Local manifest listing the eval suites and where their files live. */
interface EvalManifest {
  /** Directory the suite paths are relative to. A leading `~` is expanded. */
  root: string
  /** Suites in report order. */
  suites: EvalSuite[]
}

/** Where a file stops on its way to generation. */
type PreparationOutcome =
  | "prepared"
  | "extraction-limit"
  | "unreadable"
  | "persistence-bound"
  | "section-limit"

/** Measurements for one file. Contains no source text. */
interface FileReport {
  file: string
  role: "taught" | "reference"
  sizeBytes: number
  outcome: PreparationOutcome
  /** Failure message shown to the user or logged, when preparation stopped. */
  error?: string
  /** Page count reported by a PDF that stopped before its text was measured. */
  unextractedPages?: number
  characters?: number
  utf8Bytes?: number
  pages?: PageDensity
  sections?: SectionQuality
  durationMs: number
}

/**
 * Parses `--manifest` and `--suite` flags.
 *
 * @param argv Arguments after the script path.
 * @returns The manifest path and optional suite filter.
 * @throws Error for an unknown flag or a flag without a value.
 */
function parseArguments(argv: readonly string[]): {
  manifestPath: string
  suiteId?: string
} {
  let manifestPath = process.env.BLITZ_EVAL_MANIFEST ?? DEFAULT_MANIFEST
  let suiteId: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if ((flag === "--manifest" || flag === "--suite") && !value)
      throw new Error(`${flag} needs a value`)
    if (flag === "--manifest") manifestPath = resolve(value)
    else if (flag === "--suite") suiteId = value
    else throw new Error(`Unknown argument: ${flag}`)
    index += 1
  }
  return { manifestPath, suiteId }
}

/**
 * Reads and checks the manifest shape.
 *
 * @param path Manifest file path.
 * @returns The manifest with its root expanded to an absolute path.
 * @throws Error with setup guidance when the file is missing or malformed.
 */
async function loadManifest(path: string): Promise<EvalManifest> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    throw new Error(
      `No eval manifest at ${path}. Copy evals/suites.example.json to evals/suites.local.json and point it at your files.`
    )
  }
  const manifest = JSON.parse(raw) as EvalManifest
  if (typeof manifest.root !== "string" || !Array.isArray(manifest.suites))
    throw new Error("The eval manifest needs a root and a suites array")
  for (const suite of manifest.suites)
    if (!suite.id || !Array.isArray(suite.paths))
      throw new Error("Every eval suite needs an id and a paths array")
  return {
    ...manifest,
    root: resolve(manifest.root.replace(/^~(?=$|\/)/, homedir())),
  }
}

/**
 * Expands a suite's paths into supported files in a stable order.
 *
 * @param root Absolute manifest root.
 * @param suite Suite whose paths are expanded.
 * @returns Absolute file paths, sorted within each directory.
 * @throws Error when a listed path does not exist.
 */
async function suiteFiles(root: string, suite: EvalSuite): Promise<string[]> {
  const excluded = new Set(suite.exclude ?? [])
  const files: string[] = []
  for (const entry of suite.paths) {
    const path = join(root, entry)
    const info = await stat(path).catch(() => null)
    if (!info) throw new Error(`Suite ${suite.id} lists a missing path: ${entry}`)
    const candidates = info.isDirectory()
      ? (await readdir(path, { withFileTypes: true }))
          .filter((child) => child.isFile() && !child.name.startsWith("."))
          .map((child) => join(path, child.name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      : [path]
    files.push(
      ...candidates.filter(
        (file) =>
          SUPPORTED_EXTENSIONS.test(file) && !excluded.has(basename(file))
      )
    )
  }
  return files
}

/**
 * Maps a preparation failure to the stage where the file stopped.
 *
 * @param error Error thrown by extraction or sectioning.
 * @param stage Which stage threw it.
 * @returns The outcome category.
 */
function outcomeFor(
  error: unknown,
  stage: "extract" | "segment"
): PreparationOutcome {
  const code = error instanceof SourceIngestionError ? error.code : undefined
  if (stage === "segment")
    return code === "chunk-limit-exceeded" ? "section-limit" : "persistence-bound"
  return code === "input-too-large" ? "extraction-limit" : "unreadable"
}

/**
 * Prepares one file exactly as a desktop upload would and measures it.
 *
 * @param root Manifest root, used to report a relative path.
 * @param path Absolute file path.
 * @param suite Suite the file belongs to.
 * @returns Measurements without source text.
 */
async function measureFile(
  root: string,
  path: string,
  suite: EvalSuite
): Promise<FileReport> {
  const started = performance.now()
  const sizeBytes = (await stat(path)).size
  const base: Omit<FileReport, "outcome" | "durationMs"> = {
    file: relative(root, path),
    role: suite.reference?.includes(basename(path)) ? "reference" : "taught",
    sizeBytes,
  }
  const sourceId = `eval_${createHash("sha256").update(base.file).digest("hex").slice(0, 16)}`
  const elapsed = () => Math.round(performance.now() - started)
  let prepared
  try {
    prepared = await extractNormalizedStoredSource(
      { path, filename: basename(path), contentType: null, sizeBytes },
      sourceId
    )
  } catch (error) {
    const pageCount =
      error instanceof SourceIngestionError
        ? error.context.pageCount
        : undefined
    return {
      ...base,
      outcome: outcomeFor(error, "extract"),
      error: error instanceof Error ? error.message : String(error),
      ...(typeof pageCount === "number" ? { unextractedPages: pageCount } : {}),
      durationMs: elapsed(),
    }
  }
  const text = prepared.document.text
  const measured = {
    ...base,
    characters: text.length,
    utf8Bytes: Buffer.byteLength(text, "utf8"),
    pages: measurePageDensity(text),
  }
  try {
    const chunks = segmentPreparedDocument(prepared.document)
    return {
      ...measured,
      outcome: "prepared",
      sections: measureSectionQuality(text, chunks),
      durationMs: elapsed(),
    }
  } catch (error) {
    return {
      ...measured,
      outcome: outcomeFor(error, "segment"),
      error: error instanceof Error ? error.message : String(error),
      durationMs: elapsed(),
    }
  }
}

/**
 * Formats a ratio as a whole percentage for the console table.
 *
 * @param value Ratio from 0 to 1, or undefined.
 * @returns A percentage string, or a dash when there is no value.
 */
function percent(value: number | undefined): string {
  return value === undefined ? "–" : `${Math.round(value * 100)}%`
}

/**
 * Prints one suite's files and totals.
 *
 * @param suite Suite being reported.
 * @param reports Measurements for its files.
 */
function printSuite(suite: EvalSuite, reports: readonly FileReport[]): void {
  console.log(`\n${suite.id}: ${suite.description}`)
  console.table(
    reports.map((report) => ({
      file: basename(report.file).slice(0, 48),
      role: report.role,
      outcome: report.outcome,
      pages: report.pages?.pageCount ?? report.unextractedPages ?? "–",
      "low-text pages": report.pages?.lowTextPageCount ?? "–",
      "chars/page": report.pages?.medianCharactersPerPage ?? "–",
      KB: report.utf8Bytes ? Math.round(report.utf8Bytes / 1000) : "–",
      sections: report.sections?.sectionCount ?? "–",
      "cut mid-sentence": percent(report.sections?.midSentenceEndShare),
      "text repeated": percent(report.sections?.duplicatedShare),
      titled: percent(report.sections?.titledShare),
    }))
  )
  const pages = reports.reduce(
    (total, report) =>
      total + (report.pages?.pageCount ?? report.unextractedPages ?? 0),
    0
  )
  const preparedPages = reports
    .filter((report) => report.outcome === "prepared")
    .reduce((total, report) => total + (report.pages?.pageCount ?? 0), 0)
  const lowText = reports.reduce(
    (total, report) => total + (report.pages?.lowTextPageCount ?? 0),
    0
  )
  const stopped = reports.filter((report) => report.outcome !== "prepared")
  console.log(
    `  ${reports.length - stopped.length}/${reports.length} files reach generation with sections` +
      (pages
        ? `; ${preparedPages}/${pages} PDF pages reach generation; ${lowText} low-text pages`
        : "")
  )
  for (const report of stopped)
    console.log(`  ✗ ${basename(report.file)}: ${report.outcome} — ${report.error}`)
}

/** Runs the selected suites and writes the JSON report. */
async function main(): Promise<void> {
  // pdfjs reports font and image decoder problems through console.warn with a
  // "Warning: " prefix. They concern rendering, which extraction does not use.
  const warn = console.warn
  console.warn = (...values: unknown[]) => {
    if (typeof values[0] === "string" && values[0].startsWith("Warning: "))
      return
    warn(...values)
  }
  const { manifestPath, suiteId } = parseArguments(process.argv.slice(2))
  const manifest = await loadManifest(manifestPath)
  const suites = manifest.suites.filter(
    (suite) => !suiteId || suite.id === suiteId
  )
  if (!suites.length) throw new Error(`No suite with id ${suiteId}`)
  const results: Array<{ suite: string; files: FileReport[] }> = []
  for (const suite of suites) {
    const files: FileReport[] = []
    // Sequential runs keep large PDFs from competing for memory.
    for (const path of await suiteFiles(manifest.root, suite))
      files.push(await measureFile(manifest.root, path, suite))
    printSuite(suite, files)
    results.push({ suite: suite.id, files })
  }
  const reportDirectory = join(REPOSITORY_ROOT, ".eval")
  await mkdir(reportDirectory, { recursive: true })
  const reportPath = join(
    reportDirectory,
    `ingestion-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  )
  await writeFile(
    reportPath,
    JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2)
  )
  console.log(`\nReport: ${relative(REPOSITORY_ROOT, reportPath)}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
