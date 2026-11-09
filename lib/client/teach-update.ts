/**
 * Asks the server to update a unit's lesson from its new files. Progress is
 * read from Convex as the run is saved, so this only reports whether it started.
 */

/**
 * Starts a lesson update.
 *
 * @param unitId The unit whose lesson should be updated.
 * @returns An error message for the learner, or null when the update started
 *   or another one is already under way.
 */
export async function startTeachUpdate(unitId: string): Promise<string | null> {
  const response = await fetch("/api/teach/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unitId }),
  }).catch(() => null)
  if (!response) return "The update could not start. Check that Blitz is running."
  const payload = (await response.json().catch(() => null)) as {
    status?: unknown
    error?: unknown
  } | null
  if (!response.ok)
    return typeof payload?.error === "string"
      ? payload.error
      : "The update could not start. Try again."
  if (payload?.status === "busy") return "Wait for the reply to finish, then update the lesson."
  return null
}
