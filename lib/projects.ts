/**
 * Shares the project archive rule between the Library, project menus and any
 * other list of projects. A project is archived when `archivedAt` is set;
 * archiving keeps its data, so only default lists should skip it.
 */

/**
 * Returns whether a project is archived.
 * @param project Any project document or summary that carries `archivedAt`.
 * @returns True when `archivedAt` is set; false when the field is absent.
 */
export function isArchived(project: { archivedAt?: number }): boolean {
  return project.archivedAt !== undefined
}
