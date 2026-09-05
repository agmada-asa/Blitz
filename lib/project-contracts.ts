/** Defines project metadata and validates the small management requests shared by HTTP and native clients. */

/** Public project metadata; source content and study history are never included. */
export type ProjectSummary = { id: string; title: string; createdAt: number }

/** Validated operation accepted by the project management endpoint. */
export type ProjectOperation =
  | { action: "create"; title: string }
  | { action: "rename"; projectId: string; title: string }
  | { action: "delete"; projectId: string }

/** Trims a title and rejects blank or oversized project names. */
export function projectTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200)
    throw new Error("Use a project name between 1 and 200 characters.")
  return value.trim()
}

/** Validates the requested action and only returns fields used by that operation. */
export function parseProjectOperation(value: unknown): ProjectOperation {
  if (!value || typeof value !== "object")
    throw new Error("Project request is invalid.")
  const input = value as Record<string, unknown>
  if (input.action === "create")
    return { action: "create", title: projectTitle(input.title) }
  if (input.action !== "rename" && input.action !== "delete")
    throw new Error("Project action is invalid.")
  if (
    typeof input.projectId !== "string" ||
    !/^[a-zA-Z0-9]{1,128}$/.test(input.projectId)
  )
    throw new Error("Project ID is invalid.")
  return input.action === "rename"
    ? {
        action: "rename",
        projectId: input.projectId,
        title: projectTitle(input.title),
      }
    : { action: "delete", projectId: input.projectId }
}

/** Validates project metadata before a native client displays or acts on it. */
export function parseProjectList(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) throw new Error("Could not read the project list.")
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object")
      throw new Error("Could not read the project list.")
    const project = row as Record<string, unknown>
    if (
      typeof project.id !== "string" ||
      !/^[a-zA-Z0-9]{1,128}$/.test(project.id) ||
      typeof project.createdAt !== "number" ||
      !Number.isFinite(project.createdAt)
    )
      throw new Error("Could not read the project list.")
    return {
      id: project.id,
      title: projectTitle(project.title),
      createdAt: project.createdAt,
    }
  })
}
