/** Builds the notification center from durable jobs and AI reply records. */

import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"

/** Maximum records read for each indexed status. */
const MAX_ROWS_PER_STATUS = 8
/** Maximum finished notifications returned after all sources are merged. */
const MAX_NOTIFICATIONS = 40
/** Maximum workspace chats inspected for their latest assistant message. */
const MAX_WORKSPACE_CHATS = 24

/** Work types rendered with distinct labels and destinations. */
export type NotificationKind =
  "preparation" | "research" | "import" | "card-reply" | "workspace-reply"

/** Shared row used by active tasks and finished notifications. */
export type NotificationCenterRow = {
  id: string
  kind: NotificationKind
  title: string
  detail: string
  context: string | null
  status: "queued" | "running" | "completed" | "failed"
  stage: string
  href: string
  createdAt: number
  updatedAt: number
  elapsedSince: number | null
  elapsedMs: number
  generatedItemCount: number | null
  error: string | null
}

/** Truncates user-provided text before it becomes a compact row label. */
function compact(value: string, maximum = 96): string {
  const text = value.trim().replace(/\s+/g, " ")
  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum - 1).trimEnd()}…`
}

/** Maps a terminal row to a fixed elapsed duration and an active row to a timer. */
function timing(
  status: NotificationCenterRow["status"],
  createdAt: number,
  updatedAt: number
): Pick<NotificationCenterRow, "elapsedSince" | "elapsedMs"> {
  return status === "completed" || status === "failed"
    ? {
        elapsedSince: null,
        elapsedMs: Math.max(0, updatedAt - createdAt),
      }
    : { elapsedSince: createdAt, elapsedMs: 0 }
}

/** Lists current background work and recent results without source text or replies. */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const [
      prepQueued,
      prepLeased,
      prepFailed,
      prepCompleted,
      researchQueued,
      researchRunning,
      researchFailed,
      researchReady,
      importQueued,
      importRunning,
      importFailed,
      importCompleted,
      cardQueued,
      cardRunning,
      cardFailed,
      cardCompleted,
      workspaceChats,
    ] = await Promise.all([
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "leased"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("preparationJobs")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "completed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposals")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "ready"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("researchProposalImports")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "imported"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "queued"))
        .order("asc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "running"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "failed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("conversationMessages")
        .withIndex("by_status_createdAt", (q) => q.eq("status", "completed"))
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("workspaceChats")
        .withIndex("by_updatedAt")
        .order("desc")
        .take(MAX_WORKSPACE_CHATS),
    ])

    const preparation = [
      ...prepQueued,
      ...prepLeased,
      ...prepFailed,
      ...prepCompleted,
    ]
    const proposals = [
      ...researchQueued,
      ...researchRunning,
      ...researchFailed,
      ...researchReady,
    ]
    const imports = [
      ...importQueued,
      ...importRunning,
      ...importFailed,
      ...importCompleted,
    ]
    const cardMessages = [
      ...cardQueued,
      ...cardRunning,
      ...cardFailed,
      ...cardCompleted,
    ]

    const conversationIds = [
      ...new Set(cardMessages.map((message) => message.conversationId)),
    ]
    const conversations = new Map(
      (await Promise.all(conversationIds.map((id) => ctx.db.get(id))))
        .filter(
          (conversation): conversation is Doc<"conversations"> =>
            conversation !== null
        )
        .map((conversation) => [conversation._id, conversation])
    )
    const proposalIds = [
      ...new Set(imports.map((importRow) => importRow.proposalId)),
    ]
    const importedProposals = new Map(
      (await Promise.all(proposalIds.map((id) => ctx.db.get(id))))
        .filter(
          (proposal): proposal is Doc<"researchProposals"> => proposal !== null
        )
        .map((proposal) => [proposal._id, proposal])
    )
    const projectIds = new Set([
      ...preparation.map((job) => job.projectId),
      ...proposals.map((proposal) => proposal.projectId),
      ...imports.map((importRow) => importRow.projectId),
      ...[...conversations.values()].map(
        (conversation) => conversation.projectId
      ),
    ])
    const projects = new Map(
      (await Promise.all([...projectIds].map((id) => ctx.db.get(id))))
        .filter((project): project is Doc<"projects"> => project !== null)
        .map((project) => [project._id, project])
    )
    const learningItems = new Map(
      (
        await Promise.all(
          [...conversations.values()].map((conversation) =>
            ctx.db.get(conversation.itemId)
          )
        )
      )
        .filter((item): item is Doc<"learningItems"> => item !== null)
        .map((item) => [item._id, item])
    )
    const workspaceMessages = (
      await Promise.all(
        workspaceChats.map(async (chat) => {
          if (chat.activeMessageId) return ctx.db.get(chat.activeMessageId)
          return ctx.db
            .query("workspaceChatMessages")
            .withIndex("by_chat_createdAt", (q) => q.eq("chatId", chat._id))
            .order("desc")
            .first()
        })
      )
    ).filter(
      (message): message is Doc<"workspaceChatMessages"> =>
        message !== null && message.role === "assistant"
    )

    const rows: NotificationCenterRow[] = []
    for (const job of preparation) {
      const project = projects.get(job.projectId)
      if (!project) continue
      const status =
        job.status === "leased"
          ? "running"
          : (job.status as "queued" | "completed" | "failed")
      const section = job.totalChunks
        ? Math.min(job.nextChunkOrdinal + 1, job.totalChunks)
        : null
      rows.push({
        id: `preparation:${job._id}`,
        kind: "preparation",
        title:
          status === "completed"
            ? `${job.sourceFilename} is ready`
            : status === "failed"
              ? `${job.sourceFilename} needs attention`
              : `Preparing ${job.sourceFilename}`,
        detail:
          status === "completed"
            ? `${job.generatedItemCount ?? 0} ${job.generatedItemCount === 1 ? "study item" : "study items"} created`
            : section && job.totalChunks
              ? `Section ${section} of ${job.totalChunks}`
              : status === "queued"
                ? "Waiting to start"
                : "Creating study material",
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Ready"
            : status === "failed"
              ? "Failed"
              : status === "queued"
                ? "Queued"
                : "Preparing",
        href: `/projects/${job.projectId}`,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...timing(status, job.createdAt, job.updatedAt),
        generatedItemCount: job.generatedItemCount ?? null,
        error: job.lastError?.trim().slice(0, 500) || null,
      })
    }

    for (const proposal of proposals) {
      const project = projects.get(proposal.projectId)
      if (!project) continue
      const status =
        proposal.status === "ready"
          ? "completed"
          : (proposal.status as "queued" | "running" | "failed")
      rows.push({
        id: `research:${proposal._id}`,
        kind: "research",
        title:
          status === "completed"
            ? "Research plan is ready"
            : status === "failed"
              ? "Research needs attention"
              : "Research in progress",
        detail: compact(proposal.request),
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Review sources"
            : status === "failed"
              ? "Failed"
              : status === "queued"
                ? "Queued"
                : compact(
                    proposal.activity?.at(-1)?.label || "Finding sources"
                  ),
        href: `/projects/${proposal.projectId}?research=${encodeURIComponent(proposal.requestId)}`,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        ...timing(status, proposal.createdAt, proposal.updatedAt),
        generatedItemCount: null,
        error: proposal.lastError?.trim().slice(0, 500) || null,
      })
    }

    for (const importRow of imports) {
      const project = projects.get(importRow.projectId)
      const proposal = importedProposals.get(importRow.proposalId)
      if (!project || !proposal) continue
      const sourceTitle =
        proposal.sources[importRow.sourceIndex]?.title ||
        `Source ${importRow.sourceIndex + 1}`
      const status =
        importRow.status === "imported"
          ? "completed"
          : (importRow.status as "queued" | "running" | "failed")
      rows.push({
        id: `import:${importRow._id}`,
        kind: "import",
        title:
          status === "completed"
            ? `${sourceTitle} was added`
            : status === "failed"
              ? `${sourceTitle} could not be added`
              : `Importing ${sourceTitle}`,
        detail:
          status === "completed"
            ? "Source preparation will continue if needed"
            : status === "queued"
              ? "Waiting to download"
              : "Downloading source",
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Imported"
            : status === "failed"
              ? "Failed"
              : status === "queued"
                ? "Queued"
                : "Importing",
        href: `/projects/${importRow.projectId}?research=${encodeURIComponent(proposal.requestId)}`,
        createdAt: importRow.createdAt,
        updatedAt: importRow.updatedAt,
        ...timing(status, importRow.createdAt, importRow.updatedAt),
        generatedItemCount: null,
        error: importRow.lastError?.trim().slice(0, 500) || null,
      })
    }

    for (const message of cardMessages) {
      const conversation = conversations.get(message.conversationId)
      if (!conversation) continue
      const project = projects.get(conversation.projectId)
      const item = learningItems.get(conversation.itemId)
      if (!project || !item) continue
      const status = message.status
      rows.push({
        id: `card-reply:${message._id}`,
        kind: "card-reply",
        title:
          status === "completed"
            ? "Card reply is ready"
            : status === "failed"
              ? "Card reply failed"
              : "Preparing a card reply",
        detail: compact(message.question),
        context: `${project.title} · ${item.title}`,
        status,
        stage:
          status === "completed"
            ? "Open reply"
            : status === "failed"
              ? "Failed"
              : status === "queued"
                ? "Queued"
                : "Replying",
        href: `/chat?projectId=${encodeURIComponent(conversation.projectId)}&itemId=${encodeURIComponent(conversation.itemId)}`,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        ...timing(status, message.createdAt, message.updatedAt),
        generatedItemCount: null,
        error: message.error?.trim().slice(0, 500) || null,
      })
    }

    for (const message of workspaceMessages) {
      const chat = workspaceChats.find((row) => row._id === message.chatId)
      if (!chat) continue
      const status = message.status
      rows.push({
        id: `workspace-reply:${message._id}`,
        kind: "workspace-reply",
        title:
          status === "completed"
            ? "Chat reply is ready"
            : status === "failed"
              ? "Chat reply failed"
              : "Chat reply in progress",
        detail: compact(chat.title),
        context: "Workspace chat",
        status,
        stage:
          status === "completed"
            ? "Open reply"
            : status === "failed"
              ? "Failed"
              : "Replying",
        href: `/chat?chatId=${encodeURIComponent(chat._id)}`,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
        ...timing(status, message.createdAt, message.updatedAt),
        generatedItemCount: null,
        error: chat.lastError?.trim().slice(0, 500) || null,
      })
    }

    const tasks = rows
      .filter((row) => row.status === "queued" || row.status === "running")
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const notifications = rows
      .filter((row) => row.status === "completed" || row.status === "failed")
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_NOTIFICATIONS)
    return { tasks, notifications }
  },
})
