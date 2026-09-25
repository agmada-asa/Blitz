/** Provides the bounded HTTP contract used by the native project workspace. */

const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESPONSE_BYTES = 1_000_000

/** A source row without extracted text or other private source content. */
export type MobileWorkspaceSource = {
  readonly id: string
  readonly filename: string
  readonly status: "processing" | "ready" | "failed"
  readonly kind?: "pdf" | "markdown" | "text" | "paste"
  readonly error?: string
  readonly originalUrl?: string
  readonly unsupported?: boolean
  readonly relativeKey?: string
  readonly mimeType?: string
  readonly sizeBytes?: number
}

/** A source-grounded option that can be answered in the native walkthrough. */
export type MobileWorkspaceOption = {
  readonly id: string
  readonly text: string
}

/** One source-grounded learning item exposed without answer keys. */
export type MobileWorkspaceItem = {
  readonly id: string
  readonly conceptId: string
  readonly type: "explain" | "single-choice" | "multiple-answer" | "true-false"
  readonly title: string
  readonly body?: string
  readonly deepExplanation?: string
  readonly question?: string
  readonly options?: MobileWorkspaceOption[]
  readonly sourceLabels: string[]
}

/** One generated concept and its source-grounded study sequence. */
export type MobileWorkspaceConcept = {
  readonly id: string
  readonly title: string
  /** Legacy correct-streak status retained for older project servers. */
  readonly status: "new" | "practicing" | "mastered"
  /** Progress state based on distinct questions answered at least once. */
  readonly completionStatus: "new" | "practicing" | "completed"
  readonly answeredQuestionCount: number
  readonly questionCount: number
  readonly itemCount: number
  readonly sourceLabels: string[]
  readonly hasNewMaterial: boolean
  readonly items: MobileWorkspaceItem[]
}

/** One learning-path topic shown in the overview. */
export type MobileWorkspaceSection = {
  readonly id: string
  readonly title: string
  readonly completedConcepts: number
  /** Retained as a fallback for responses from older project servers. */
  readonly masteredConcepts: number
  readonly hasNewMaterial: boolean
  readonly concepts: MobileWorkspaceConcept[]
}

/** Bounded preparation state for a source. */
export type MobileWorkspacePreparation = {
  readonly sourceId: string
  readonly status: "queued" | "leased" | "failed" | "completed"
  readonly error?: string | null
  readonly nextChunkOrdinal?: number
  readonly totalChunks?: number
  readonly generatedItemCount?: number
  readonly leaseExpired?: boolean
}

/** Bounded ingestion state for a source. */
export type MobileWorkspaceIngestion = {
  readonly sourceId: string
  readonly status: "queued" | "running" | "completed" | "failed"
  readonly error?: string
}

/** Generated file metadata. The native client receives no file contents. */
export type MobileWorkspaceArtifact = {
  readonly id: string
  readonly relativeKey: string
  readonly kind: "file" | "directory"
  readonly mimeType?: string
  readonly sizeBytes?: number
  readonly status: "active" | "deleted"
  readonly updatedAt?: number
}

/** A citation label associated with one source. */
export type MobileWorkspaceCitation = {
  readonly sourceId: string
  readonly label: string
  readonly detail?: string
}

/** The safe, screen-ready response for one project detail page. */
export type MobileWorkspacePayload = {
  readonly project: { readonly id: string; readonly title: string }
  readonly path: {
    readonly sections: MobileWorkspaceSection[]
    readonly stats: {
      readonly sectionCount: number
      readonly conceptCount: number
      readonly answeredQuestionCount: number
      readonly completedConceptCount: number
      /** Retained as a fallback for responses from older project servers. */
      readonly masteredConceptCount: number
      readonly questionCount: number
    }
    readonly isTruncated: boolean
  }
  readonly sources: MobileWorkspaceSource[]
  readonly ingestion: MobileWorkspaceIngestion[]
  readonly preparation: MobileWorkspacePreparation[]
  readonly artifacts: MobileWorkspaceArtifact[]
  readonly citations: MobileWorkspaceCitation[]
  readonly research: MobileResearchProposal[]
}

/** The latest persisted research proposal, without lease credentials. */
export type MobileResearchProposal = {
  readonly requestId: string
  readonly request: string
  readonly status: "queued" | "running" | "ready" | "failed"
  readonly error?: string
  readonly proposal: {
    readonly scope: string
    readonly topics: string[]
    readonly sources: Array<{
      readonly url: string
      readonly title: string
      readonly reason: string
      readonly verification: "suggested-unverified" | "checked"
    }>
    readonly generatedNotes: Array<{
      readonly title: string
      readonly description: string
      readonly reason: string
    }>
  } | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** A native source action accepted by the project detail route. */
export type MobileSourceAction =
  | {
      readonly action: "paste"
      readonly filename?: string
      readonly text: string
    }
  | { readonly action: "link"; readonly url: string }

/** Error raised for unavailable servers or invalid server payloads. */
export class MobileWorkspaceApiError extends Error {
  /** Creates a user-safe transport or validation error. */
  constructor(message: string) {
    super(message)
    this.name = "MobileWorkspaceApiError"
  }
}

/** Removes trailing slashes and requires an explicit HTTP service URL. */
function base(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(value))
    throw new MobileWorkspaceApiError(
      "Enter a server URL beginning with http:// or https://"
    )
  return value
}

/** Returns true for a plain JSON object. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads a bounded JSON response and hides response-body details on errors. */
async function json(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_RESPONSE_BYTES)
    throw new MobileWorkspaceApiError("The project response is too large")
  let value: unknown
  try {
    value = text ? JSON.parse(text) : undefined
  } catch {
    throw new MobileWorkspaceApiError("The project response was unreadable")
  }
  if (!response.ok) {
    const message =
      record(value) && typeof value.error === "string"
        ? value.error
        : "The project could not be loaded"
    throw new MobileWorkspaceApiError(message)
  }
  return value
}

/** Fetches one workspace response with cancellation and a twelve-second timeout. */
async function request(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort()
  init?.signal?.addEventListener("abort", abort, { once: true })
  try {
    return await json(await fetch(url, { ...init, signal: controller.signal }))
  } catch (error) {
    if (controller.signal.aborted)
      throw new MobileWorkspaceApiError(
        "The project request timed out. Try again."
      )
    if (error instanceof MobileWorkspaceApiError) throw error
    throw new MobileWorkspaceApiError("Could not reach the project server")
  } finally {
    clearTimeout(timeout)
    init?.signal?.removeEventListener("abort", abort)
  }
}

/** Validates the project detail response before native rendering. */
function parseWorkspace(value: unknown): MobileWorkspacePayload {
  if (!record(value) || !record(value.project) || !record(value.path))
    throw new MobileWorkspaceApiError("The project response is incomplete")
  if (
    typeof value.project.id !== "string" ||
    typeof value.project.title !== "string"
  )
    throw new MobileWorkspaceApiError("The project response is invalid")
  if (!Array.isArray(value.path.sections) || !record(value.path.stats))
    throw new MobileWorkspaceApiError("The learning overview is invalid")
  const path = value.path as Record<string, unknown>
  const stats = path.stats as Record<string, unknown>
  const numberField = (field: string): number =>
    typeof stats[field] === "number" && Number.isFinite(stats[field])
      ? stats[field]
      : 0
  const rawSections = Array.isArray(path.sections) ? path.sections : []

  /** Parses one answer-safe walkthrough item and drops malformed options. */
  function parseItem(value: unknown): MobileWorkspaceItem | null {
    if (
      !record(value) ||
      typeof value.id !== "string" ||
      typeof value.conceptId !== "string" ||
      typeof value.type !== "string" ||
      typeof value.title !== "string"
    )
      return null
    if (
      value.type !== "explain" &&
      value.type !== "single-choice" &&
      value.type !== "multiple-answer" &&
      value.type !== "true-false"
    )
      return null
    const options = Array.isArray(value.options)
      ? value.options
          .flatMap((option): MobileWorkspaceOption[] =>
            record(option) &&
            typeof option.id === "string" &&
            typeof option.text === "string"
              ? [{ id: option.id, text: option.text }]
              : []
          )
          .slice(0, 12)
      : undefined
    return {
      id: value.id,
      conceptId: value.conceptId,
      type: value.type,
      title: value.title,
      ...(typeof value.body === "string" ? { body: value.body } : {}),
      ...(typeof value.deepExplanation === "string"
        ? { deepExplanation: value.deepExplanation }
        : {}),
      ...(typeof value.question === "string"
        ? { question: value.question }
        : {}),
      ...(options?.length ? { options } : {}),
      sourceLabels: Array.isArray(value.sourceLabels)
        ? value.sourceLabels
            .filter((label): label is string => typeof label === "string")
            .slice(0, 20)
        : [],
    }
  }

  const sections = rawSections
    .slice(0, 100)
    .map((section: unknown): MobileWorkspaceSection => {
      if (
        !record(section) ||
        typeof section.id !== "string" ||
        typeof section.title !== "string" ||
        !Array.isArray(section.concepts)
      )
        throw new MobileWorkspaceApiError(
          "The learning overview contains an invalid topic"
        )
      return {
        id: section.id,
        title: section.title,
        completedConcepts:
          typeof section.completedConcepts === "number"
            ? section.completedConcepts
            : typeof section.masteredConcepts === "number"
              ? section.masteredConcepts
              : 0,
        masteredConcepts:
          typeof section.masteredConcepts === "number"
            ? section.masteredConcepts
            : 0,
        hasNewMaterial: section.hasNewMaterial === true,
        concepts: section.concepts.slice(0, 100).flatMap((concept) => {
          if (
            !record(concept) ||
            typeof concept.id !== "string" ||
            typeof concept.title !== "string"
          )
            return []
          const items = Array.isArray(concept.items)
            ? concept.items.slice(0, 100).flatMap((item) => {
                const parsed = parseItem(item)
                return parsed ? [parsed] : []
              })
            : []
          const questionCount =
            typeof concept.questionCount === "number"
              ? concept.questionCount
              : items.filter((item) => item.type !== "explain").length
          const answeredQuestionCount =
            typeof concept.answeredQuestionCount === "number"
              ? concept.answeredQuestionCount
              : concept.status === "mastered"
                ? questionCount
                : 0
          return [
            {
              id: concept.id,
              title: concept.title,
              status:
                concept.status === "mastered" || concept.status === "practicing"
                  ? concept.status
                  : "new",
              completionStatus:
                concept.completionStatus === "completed" ||
                concept.completionStatus === "practicing"
                  ? concept.completionStatus
                  : concept.status === "mastered"
                    ? "completed"
                    : concept.status === "practicing"
                      ? "practicing"
                      : "new",
              answeredQuestionCount,
              questionCount,
              itemCount: items.length,
              hasNewMaterial: concept.hasNewMaterial === true,
              items,
              sourceLabels: Array.isArray(concept.sourceLabels)
                ? concept.sourceLabels
                    .filter(
                      (label): label is string => typeof label === "string"
                    )
                    .slice(0, 20)
                : [],
            },
          ]
        }),
      }
    })
  return {
    project: { id: value.project.id, title: value.project.title },
    path: {
      sections,
      stats: {
        sectionCount: numberField("sectionCount"),
        conceptCount: numberField("conceptCount"),
        answeredQuestionCount: numberField("answeredQuestionCount"),
        completedConceptCount:
          typeof stats.completedConceptCount === "number"
            ? numberField("completedConceptCount")
            : numberField("masteredConceptCount"),
        masteredConceptCount: numberField("masteredConceptCount"),
        questionCount: numberField("questionCount"),
      },
      isTruncated: path.isTruncated === true,
    },
    sources: Array.isArray(value.sources)
      ? value.sources.slice(0, 20).flatMap(parseSource)
      : [],
    ingestion: Array.isArray(value.ingestion)
      ? value.ingestion.slice(0, 20).flatMap(parseIngestion)
      : [],
    preparation: Array.isArray(value.preparation)
      ? value.preparation.slice(0, 20).flatMap(parsePreparation)
      : [],
    artifacts: Array.isArray(value.artifacts)
      ? value.artifacts.slice(0, 100).flatMap(parseArtifact)
      : [],
    citations: Array.isArray(value.citations)
      ? value.citations.slice(0, 500).flatMap(parseCitation)
      : [],
    research: Array.isArray(value.research)
      ? value.research.slice(0, 20).flatMap(parseResearch)
      : [],
  }
}

/** Parses a source row while dropping malformed optional rows. */
function parseSource(value: unknown): MobileWorkspaceSource[] {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.filename !== "string"
  )
    return []
  return [
    {
      id: value.id,
      filename: value.filename,
      status:
        value.status === "ready" || value.status === "failed"
          ? value.status
          : "processing",
      ...(typeof value.kind === "string"
        ? { kind: value.kind as MobileWorkspaceSource["kind"] }
        : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(typeof value.originalUrl === "string"
        ? { originalUrl: value.originalUrl }
        : {}),
      ...(typeof value.relativeKey === "string"
        ? { relativeKey: value.relativeKey }
        : {}),
      ...(typeof value.mimeType === "string"
        ? { mimeType: value.mimeType }
        : {}),
      ...(typeof value.sizeBytes === "number"
        ? { sizeBytes: value.sizeBytes }
        : {}),
      ...(value.unsupported === true ? { unsupported: true } : {}),
    },
  ]
}

/** Parses bounded ingestion metadata. */
function parseIngestion(value: unknown): MobileWorkspaceIngestion[] {
  if (!record(value) || typeof value.sourceId !== "string") return []
  return [
    {
      sourceId: value.sourceId,
      status:
        value.status === "running" ||
        value.status === "completed" ||
        value.status === "failed"
          ? value.status
          : "queued",
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    },
  ]
}

/** Parses bounded preparation metadata. */
function parsePreparation(value: unknown): MobileWorkspacePreparation[] {
  if (!record(value) || typeof value.sourceId !== "string") return []
  return [
    {
      sourceId: value.sourceId,
      status:
        value.status === "leased" ||
        value.status === "failed" ||
        value.status === "completed"
          ? value.status
          : "queued",
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      ...(typeof value.nextChunkOrdinal === "number"
        ? { nextChunkOrdinal: value.nextChunkOrdinal }
        : {}),
      ...(typeof value.totalChunks === "number"
        ? { totalChunks: value.totalChunks }
        : {}),
      ...(typeof value.generatedItemCount === "number"
        ? { generatedItemCount: value.generatedItemCount }
        : {}),
      ...(value.leaseExpired === true ? { leaseExpired: true } : {}),
    },
  ]
}

/** Parses one generated artifact metadata row. */
function parseArtifact(value: unknown): MobileWorkspaceArtifact[] {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.relativeKey !== "string"
  )
    return []
  return [
    {
      id: value.id,
      relativeKey: value.relativeKey,
      kind: value.kind === "directory" ? "directory" : "file",
      status: value.status === "deleted" ? "deleted" : "active",
      ...(typeof value.mimeType === "string"
        ? { mimeType: value.mimeType }
        : {}),
      ...(typeof value.sizeBytes === "number"
        ? { sizeBytes: value.sizeBytes }
        : {}),
      ...(typeof value.updatedAt === "number"
        ? { updatedAt: value.updatedAt }
        : {}),
    },
  ]
}

/** Parses one citation label without retaining source chunk content. */
function parseCitation(value: unknown): MobileWorkspaceCitation[] {
  if (
    !record(value) ||
    typeof value.sourceId !== "string" ||
    typeof value.label !== "string"
  )
    return []
  return [
    {
      sourceId: value.sourceId,
      label: value.label,
      ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    },
  ]
}

/** Parses one recent research proposal. */
function parseResearch(value: unknown): MobileResearchProposal[] {
  if (
    !record(value) ||
    typeof value.requestId !== "string" ||
    typeof value.request !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.updatedAt !== "number"
  )
    return []
  const rawProposal = record(value.proposal) ? value.proposal : null
  const proposal = rawProposal
    ? {
        scope: typeof rawProposal.scope === "string" ? rawProposal.scope : "",
        topics: Array.isArray(rawProposal.topics)
          ? rawProposal.topics
              .filter((topic): topic is string => typeof topic === "string")
              .slice(0, 12)
          : [],
        sources: Array.isArray(rawProposal.sources)
          ? rawProposal.sources
              .flatMap((source) =>
                record(source) &&
                typeof source.url === "string" &&
                typeof source.title === "string" &&
                typeof source.reason === "string"
                  ? [
                      {
                        url: source.url,
                        title: source.title,
                        reason: source.reason,
                        verification:
                          source.verification === "checked"
                            ? ("checked" as const)
                            : ("suggested-unverified" as const),
                      },
                    ]
                  : []
              )
              .slice(0, 20)
          : [],
        generatedNotes: Array.isArray(rawProposal.generatedNotes)
          ? rawProposal.generatedNotes
              .flatMap((note) =>
                record(note) &&
                typeof note.title === "string" &&
                typeof note.description === "string" &&
                typeof note.reason === "string"
                  ? [
                      {
                        title: note.title,
                        description: note.description,
                        reason: note.reason,
                      },
                    ]
                  : []
              )
              .slice(0, 12)
          : [],
      }
    : null
  return [
    {
      requestId: value.requestId,
      request: value.request,
      status:
        value.status === "running" ||
        value.status === "ready" ||
        value.status === "failed"
          ? value.status
          : "queued",
      ...(typeof value.error === "string" ? { error: value.error } : {}),
      proposal,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
  ]
}

/** Loads one project workspace and all screen-safe supporting sections. */
export async function fetchProjectWorkspace(
  baseUrl: string,
  projectId: string,
  signal?: AbortSignal
): Promise<MobileWorkspacePayload> {
  const value = await request(
    `${base(baseUrl)}/api/mobile/projects/${encodeURIComponent(projectId)}`,
    { signal }
  )
  return parseWorkspace(value)
}

/** Queues bounded pasted notes for server-side preparation. */
export async function createProjectSource(
  baseUrl: string,
  projectId: string,
  input: Extract<MobileSourceAction, { action: "paste" }>
): Promise<void> {
  await request(
    `${base(baseUrl)}/api/mobile/projects/${encodeURIComponent(projectId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }
  )
}

/** Fetches, extracts, and queues a public source URL on the server. */
export async function importProjectLink(
  baseUrl: string,
  projectId: string,
  url: string
): Promise<void> {
  await request(
    `${base(baseUrl)}/api/mobile/projects/${encodeURIComponent(projectId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "link", url }),
    }
  )
}

/** Retries a failed source through the existing bounded retry endpoint. */
export async function retryProjectSource(
  baseUrl: string,
  projectId: string,
  sourceId: string
): Promise<void> {
  await request(`${base(baseUrl)}/api/sources/retry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, sourceId }),
  })
}

/** Builds the existing bounded artifact URL for a parent-provided URL opener. */
export function projectArtifactUrl(
  baseUrl: string,
  projectId: string,
  relativeKey: string
): string {
  return `${base(baseUrl)}/api/projects/${encodeURIComponent(projectId)}/agent/artifacts?key=${encodeURIComponent(relativeKey)}`
}
