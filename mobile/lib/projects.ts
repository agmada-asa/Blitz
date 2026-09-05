/** Adapts native project management to the local HTTP service with bounded requests and validated metadata. */

import {
  parseProjectList,
  type ProjectOperation,
} from "../../lib/project-contracts"

/** Fetches one project response, forwards cancellation, and reports safe server errors. */
async function request(
  baseUrl: string,
  operation?: ProjectOperation,
  signal?: AbortSignal
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  /** Cancels an obsolete request when its screen closes or changes server. */
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const response = await fetch(
      `${baseUrl.trim().replace(/\/+$/, "")}/api/projects`,
      {
        method: operation ? "POST" : "GET",
        headers: operation ? { "Content-Type": "application/json" } : undefined,
        body: operation ? JSON.stringify(operation) : undefined,
        signal: controller.signal,
      }
    )
    const body: unknown = await response.json()
    if (!response.ok) {
      const message =
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : "Could not update projects. Try again."
      throw new Error(message)
    }
    return body
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "The request timed out. Refresh projects before trying again."
      )
    throw error instanceof Error
      ? error
      : new Error("Could not reach Blitz. Try again.")
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

/** Loads all project metadata, including projects with no study content. */
export async function fetchProjects(baseUrl: string, signal?: AbortSignal) {
  return parseProjectList(await request(baseUrl, undefined, signal))
}

/** Performs one user-confirmed mutation; transport failures are never retried automatically. */
export async function updateProject(
  baseUrl: string,
  operation: ProjectOperation
): Promise<string> {
  const result = await request(baseUrl, operation)
  if (
    !result ||
    typeof result !== "object" ||
    !("id" in result) ||
    typeof result.id !== "string"
  )
    throw new Error(
      "Could not confirm the change. Refresh projects before trying again."
    )
  return result.id
}
