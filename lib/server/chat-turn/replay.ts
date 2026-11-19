/**
 * Rebuilds an ordinary chat's prompt from its saved transcript, for a turn
 * whose provider session is missing, reset, or could not be copied.
 */

import type { ConvexHttpClient } from "convex/browser"

import {
  buildWorkspaceChatPrompt,
  mergeWorkspaceChatReplay,
  type WorkspaceChatCardContext,
  type WorkspaceChatProjectContext,
  type WorkspaceChatReplayContext,
  type WorkspaceChatRequest,
} from "../workspace-chat.ts"
import { getCardContext, getProjectContext } from "./functions.ts"

/**
 * Builds a prompt carrying the chat's earlier dialogue and context. Projects
 * and a card attached on earlier turns are loaded again; ones that were
 * removed since are left out rather than failing the turn.
 *
 * @param client - Convex client for the personal deployment.
 * @param request - This turn's request.
 * @param replay - The chat's saved transcript and context.
 * @param projects - Projects already loaded for this turn.
 * @param card - The card already loaded for this turn, if any.
 */
export async function replayedChatPrompt(
  client: ConvexHttpClient,
  request: WorkspaceChatRequest,
  replay: WorkspaceChatReplayContext,
  projects: readonly WorkspaceChatProjectContext[],
  card: WorkspaceChatCardContext | undefined
): Promise<string> {
  const merged = mergeWorkspaceChatReplay(request, replay)
  const currentProjects = new Map(
    projects.map((project) => [project.id, project] as const)
  )
  const missingProjectIds = merged.request.projectIds.filter(
    (projectId) => !currentProjects.has(projectId)
  )
  const recoveredProjects = await Promise.all(
    missingProjectIds.map(async (projectId) => {
      try {
        return (
          await client.query(getProjectContext, {
            projectIds: [projectId],
            question: request.message,
          })
        )[0]
      } catch {
        return undefined
      }
    })
  )
  for (const project of recoveredProjects)
    if (project) currentProjects.set(project.id, project)
  let recoveredCard = card
  if (!recoveredCard && merged.card) {
    try {
      recoveredCard = await client.query(getCardContext, merged.card)
    } catch {
      // Deleted or unprepared historical cards cannot block recovery.
    }
  }
  return buildWorkspaceChatPrompt(
    merged.request,
    merged.request.projectIds
      .map((projectId) => currentProjects.get(projectId))
      .filter(
        (project): project is WorkspaceChatProjectContext =>
          project !== undefined
      ),
    recoveredCard,
    merged.history
  )
}
