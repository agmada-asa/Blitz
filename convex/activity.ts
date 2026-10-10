/** Builds the notification center from durable jobs and AI reply records. */

import { v } from "convex/values"

import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"

/** Maximum records read for each indexed status. */
const MAX_ROWS_PER_STATUS = 8
/** Maximum finished notifications returned after all sources are merged. */
const MAX_NOTIFICATIONS = 40
/** Maximum workspace chats inspected for their latest assistant message. */
const MAX_WORKSPACE_CHATS = 24

/**
 * How long question bank, paper, and marking runs may stay running before
 * they count as stopped. Matches the leases in practice.ts and exam.ts.
 */
const RUN_LEASE_MS = 10 * 60 * 1000

/** Work types rendered with distinct labels and destinations. */
export type NotificationKind =
  | "practice"
  | "exam-paper"
  | "exam-marking"
  | "research"
  | "import"
  | "card-reply"
  | "workspace-reply"

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
  args: {
    /**
     * Current time from the client's minute clock. When given, runs past their
     * lease show as stopped instead of running forever.
     */
    now: v.optional(v.number()),
  },
  handler: async (ctx, { now }) => {
    const [
      questionRuns,
      examPapers,
      examAttempts,
      researchQueued,
      researchRunning,
      researchFailed,
      researchReady,
      importQueued,
      importRunning,
      importFailed,
      importCompleted,
      cardFailed,
      cardCompleted,
      workspaceChats,
    ] = await Promise.all([
      ctx.db
        .query("questionGenerations")
        .withIndex("by_startedAt")
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("examPapers")
        .withIndex("by_createdAt")
        .order("desc")
        .take(MAX_ROWS_PER_STATUS),
      ctx.db
        .query("examAttempts")
        .withIndex("by_submittedAt")
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
      // Card chat has no worker any more (docs/card-chat.md), so queued and
      // running card questions never progress. Listing them would show
      // permanent in-progress work; only their settled history is shown.
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

    const markedAttempts = examAttempts.filter(
      (attempt) =>
        attempt.gradingStatus !== undefined &&
        attempt.gradingStatus !== "not_needed"
    )
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
    const units = new Map(
      (
        await Promise.all(
          [...new Set(questionRuns.map((run) => run.unitId))].map((id) =>
            ctx.db.get(id)
          )
        )
      )
        .filter((unit): unit is Doc<"units"> => unit !== null)
        .map((unit) => [unit._id, unit])
    )
    const papers = new Map<string, Doc<"examPapers">>(
      examPapers.map((paper) => [paper._id, paper])
    )
    for (const paperId of new Set(markedAttempts.map((a) => a.paperId))) {
      if (papers.has(paperId)) continue
      const paper = await ctx.db.get(paperId)
      if (paper) papers.set(paper._id, paper)
    }
    const projectIds = new Set([
      ...questionRuns.map((run) => run.projectId),
      ...[...papers.values()].map((paper) => paper.projectId),
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
        message !== null &&
        message.role === "assistant" &&
        workspaceChats.some(
          (chat) => chat._id === message.chatId && chat.isUnread === true
        )
    )

    const rows: NotificationCenterRow[] = []
    /** True when a run started before the lease and never finished. */
    const stalled = (startedAt: number) =>
      now !== undefined && startedAt <= now - RUN_LEASE_MS

    for (const run of questionRuns) {
      const project = projects.get(run.projectId)
      const unit = units.get(run.unitId)
      if (!project || !unit) continue
      const status: NotificationCenterRow["status"] =
        run.status === "running" && stalled(run.startedAt)
          ? "failed"
          : run.status
      const updatedAt = run.finishedAt ?? run.startedAt
      rows.push({
        id: `practice:${run._id}`,
        kind: "practice",
        title:
          status === "completed"
            ? `Practice questions ready for ${compact(unit.title, 64)}`
            : status === "failed"
              ? `Practice questions for ${compact(unit.title, 64)} need attention`
              : `Writing practice questions for ${compact(unit.title, 64)}`,
        detail:
          status === "completed"
            ? run.createdCount
              ? `${run.createdCount} ${run.createdCount === 1 ? "question" : "questions"} added`
              : "No new questions were needed"
            : status === "failed"
              ? "Open Practice to try again"
              : "Writing questions from this unit's sources",
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Ready"
            : status === "failed"
              ? "Failed"
              : "Writing",
        href: `/projects/${run.projectId}/practice`,
        createdAt: run.startedAt,
        updatedAt,
        ...timing(status, run.startedAt, updatedAt),
        generatedItemCount: status === "completed" ? run.createdCount : null,
        error:
          status === "failed"
            ? run.error?.trim().slice(0, 500) ||
              "Writing questions stopped before finishing."
            : null,
      })
    }

    for (const paper of examPapers) {
      // A deleted past paper keeps an empty failed row; it is not work to report.
      if (paper.deletedAt) continue
      const project = projects.get(paper.projectId)
      if (!project) continue
      const status: NotificationCenterRow["status"] =
        paper.status === "processing"
          ? stalled(paper.runStartedAt)
            ? "failed"
            : "running"
          : paper.status === "ready"
            ? "completed"
            : "failed"
      const title = compact(paper.title, 72)
      const updatedAt = paper.finishedAt ?? paper.runStartedAt
      rows.push({
        id: `exam-paper:${paper._id}`,
        kind: "exam-paper",
        title:
          status === "completed"
            ? `${title} is ready`
            : status === "failed"
              ? `${title} needs attention`
              : paper.kind === "past"
                ? `Reading ${title}`
                : `Writing ${title}`,
        detail:
          status === "completed"
            ? `${paper.questions.length} ${paper.questions.length === 1 ? "question" : "questions"}${paper.totalMarks ? `, ${paper.totalMarks} marks` : ""}`
            : status === "failed"
              ? "Open exam prep to try again"
              : paper.kind === "past"
                ? "Finding the questions in your past paper"
                : "Writing a mock exam from your units",
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Ready"
            : status === "failed"
              ? "Failed"
              : paper.kind === "past"
                ? "Reading"
                : "Writing",
        href:
          status === "completed"
            ? `/projects/${paper.projectId}/practice/exam/${paper._id}`
            : `/projects/${paper.projectId}/practice`,
        createdAt: paper.runStartedAt,
        updatedAt,
        ...timing(status, paper.runStartedAt, updatedAt),
        generatedItemCount: null,
        error:
          status === "failed"
            ? paper.error?.trim().slice(0, 500) ||
              "Preparing this paper stopped before finishing."
            : null,
      })
    }

    for (const attempt of markedAttempts) {
      const paper = papers.get(attempt.paperId)
      const project = projects.get(attempt.projectId)
      if (!paper || !project) continue
      const startedAt =
        attempt.gradingStartedAt ?? attempt.submittedAt ?? attempt.updatedAt
      const status: NotificationCenterRow["status"] =
        attempt.gradingStatus === "running"
          ? stalled(startedAt)
            ? "failed"
            : "running"
          : attempt.gradingStatus === "completed"
            ? "completed"
            : "failed"
      const title = compact(paper.title, 72)
      const updatedAt = attempt.gradedAt ?? startedAt
      rows.push({
        // Includes the run start so marking again after a failure notifies again.
        id: `exam-marking:${attempt._id}:${startedAt}`,
        kind: "exam-marking",
        title:
          status === "completed"
            ? `${title} is marked`
            : status === "failed"
              ? `Marking ${title} needs attention`
              : `Marking ${title}`,
        detail:
          status === "completed" && attempt.availableMarks
            ? `${attempt.awardedMarks ?? 0} of ${attempt.availableMarks} marks`
            : status === "failed"
              ? "Open your results to try marking again"
              : "Marking your written answers",
        context: project.title,
        status,
        stage:
          status === "completed"
            ? "Marked"
            : status === "failed"
              ? "Failed"
              : "Marking",
        href: `/projects/${attempt.projectId}/practice/exam/${attempt.paperId}?attempt=${attempt._id}`,
        createdAt: startedAt,
        updatedAt,
        ...timing(status, startedAt, updatedAt),
        generatedItemCount: null,
        error:
          status === "failed"
            ? attempt.gradingError?.trim().slice(0, 500) ||
              "Marking stopped before finishing."
            : null,
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
            ? "Added to your sources"
            : status === "failed"
              ? "Open the research plan to try again"
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
      // Teach replies are read on the Teach screen as they stream; no notice needed.
      if (!chat || chat.purpose === "teach") continue
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
      .filter(
        (row) =>
          (row.status === "queued" || row.status === "running") &&
          row.kind !== "card-reply" &&
          row.kind !== "workspace-reply"
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const notifications = rows
      .filter(
        (row) =>
          (row.status === "completed" || row.status === "failed") &&
          row.kind !== "card-reply" &&
          row.kind !== "workspace-reply"
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_NOTIFICATIONS)
    const chatNotifications = rows.filter(
      (row) => row.kind === "workspace-reply"
    )
    return { tasks, notifications, chatNotifications }
  },
})
