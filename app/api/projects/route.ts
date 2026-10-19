/** Exposes the existing local project's management operations to the native app without sharing Convex configuration. */

import type { ConvexHttpClient } from "convex/browser"
import { serverConvexClient } from "@/lib/server/convex"
import { ConvexError } from "convex/values"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { parseProjectOperation } from "@/lib/project-contracts"
import { LearningApiError, readLearningJson } from "@/lib/server/learning-api"

/** Runs the local Convex adapter on the Node.js server. */
export const runtime = "nodejs"

/** Connects to the same personal deployment used by the browser; no new access model is introduced. */
function client(): ConvexHttpClient {
  return serverConvexClient(
    () => new LearningApiError("Projects are unavailable. Try again.", 503)
  )
}

/** Converts expected validation errors into safe responses, withholding internal backend details. */
function failure(error: unknown) {
  if (error instanceof LearningApiError)
    return Response.json({ error: error.message }, { status: error.status })
  if (error instanceof ConvexError && typeof error.data === "string")
    return Response.json({ error: error.data }, { status: 400 })
  return Response.json(
    { error: "Projects are unavailable. Try again." },
    { status: 503 }
  )
}

/** Lists metadata even when a project has no prepared cards yet. */
export async function GET() {
  try {
    const projects = await client().query(api.projects.listProjects)
    return Response.json(
      projects.map((project) => ({
        id: project._id,
        title: project.title,
        createdAt: project.createdAt,
      })),
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return failure(error)
  }
}

/** Validates and executes one explicitly selected project operation. */
export async function POST(request: Request) {
  try {
    // Native requests have no Origin; browser callers must belong to this server.
    const origin = request.headers.get("origin")
    if (origin && origin !== new URL(request.url).origin)
      return Response.json(
        { error: "Project request is not allowed." },
        { status: 403 }
      )
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return Response.json(
        { error: "Use a JSON project request." },
        { status: 415 }
      )
    const body = await readLearningJson(request)
    let input
    try {
      input = parseProjectOperation(body)
    } catch (error) {
      throw new LearningApiError(
        error instanceof Error ? error.message : "Project request is invalid.",
        400
      )
    }
    const convex = client()
    if (input.action === "create") {
      const id = await convex.mutation(api.projects.createProject, {
        title: input.title,
      })
      return Response.json({ id }, { status: 201 })
    }
    const projectId = input.projectId as Id<"projects">
    if (input.action === "rename")
      await convex.mutation(api.projects.renameProject, {
        projectId,
        title: input.title,
      })
    else await convex.mutation(api.projects.deleteProject, { projectId })
    return Response.json({ id: projectId })
  } catch (error) {
    return failure(error)
  }
}
