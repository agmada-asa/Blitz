/** Defines the project-scoped filesystem boundary used by the Electron bridge. */

import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { realpath } from "node:fs/promises"
import { fileURLToPath } from "node:url"

/** Returns the local data root, with an override for development and tests. */
export function dataRoot() {
  return resolve(
    process.env.BLITZ_DATA_DIR?.trim() || join(homedir(), "Documents", "Blitz")
  )
}

/** Validates an ID before it is used as a directory name. */
export function validateProjectId(projectId) {
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9]{1,128}$/.test(projectId))
    throw new Error("Project ID is invalid.")
  return projectId
}

/** Returns the stable directory reserved for one project. */
export function projectDirectory(projectId) {
  const identity = createHash("sha256")
    .update(validateProjectId(projectId))
    .digest("hex")
    .slice(0, 24)
  return join(dataRoot(), "Projects", `project-${identity}`)
}

/** Returns true when a path is inside a directory, including the directory itself. */
export function isWithin(directory, candidate) {
  const relativePath = relative(resolve(directory), resolve(candidate))
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

/** Resolves an existing path and verifies it remains under the selected project. */
export async function assertProjectPath(projectId, candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate))
    throw new Error("A project file path is required.")
  const project = projectDirectory(projectId)
  const [realProject, realCandidate] = await Promise.all([
    realpath(project),
    realpath(candidate),
  ])
  if (!isWithin(realProject, realCandidate))
    throw new Error("That file is outside the selected project.")
  return realCandidate
}

/** Returns a safe default directory for native source selection. */
export function projectSourcesDirectory(projectId) {
  return join(projectDirectory(projectId), "Sources")
}

/** Returns the repository directory from this module's location. */
export function repositoryRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}
