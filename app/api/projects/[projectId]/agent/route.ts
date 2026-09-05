/** Reports project-agent availability without granting an unenforceable filesystem policy. */
import { PROJECT_AGENT_UNAVAILABLE } from "@/lib/server/project-agent"

/** Uses the local Node host for project agent capabilities. */
export const runtime = "nodejs"

/** Lets the interface explain the unavailable capability before a task is submitted. */
export function GET(): Response {
  return Response.json({ available: false, error: PROJECT_AGENT_UNAVAILABLE }, { headers: { "Cache-Control": "no-store" } })
}

/** Refuses task launch until the host can isolate reads and protected source writes. */
export function POST(): Response {
  return Response.json({ error: PROJECT_AGENT_UNAVAILABLE }, { status: 503 })
}
