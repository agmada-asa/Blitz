/**
 * Turns a saved chat into the Markdown transcript offered by the chat
 * workspace's Export chat dialog, optionally with the agent's working notes,
 * tool calls and requests.
 */
import type { ProviderActivityEvent } from "../provider-activity"
import type { AgentRequest } from "../agent-request"
import { agentRequestFromValue } from "./workspace-chat-events.ts"

/** The parts of a saved chat message an export reads. */
export type ExportableMessage = {
  role: string
  content: string
  thought?: unknown
  providerEvents?: unknown
  agentRequests?: unknown
}

/**
 * Formats a conversation as Markdown, one section per message.
 *
 * @param title - The chat's title; blank titles become "Chat".
 * @param messages - Messages in order.
 * @param includeAgentActivity - Adds each reply's working notes, tool calls and agent requests.
 * @returns The transcript, ending in a newline.
 */
export function chatMarkdown(
  title: string | undefined,
  messages: readonly ExportableMessage[],
  includeAgentActivity: boolean
): string {
  const sections = [`# ${title?.trim() || "Chat"}`]
  for (const message of messages) {
    const heading = message.role === "user" ? "You" : "Blitz"
    sections.push(`## ${heading}\n\n${message.content || "_(No message text)_"}`)
    if (!includeAgentActivity || message.role !== "assistant") continue

    const thought =
      typeof message.thought === "string" ? message.thought.trim() : ""
    if (thought) sections.push(`### Agent working\n\n${thought}`)

    const events = Array.isArray(message.providerEvents)
      ? (message.providerEvents as ProviderActivityEvent[])
      : []
    for (const event of events) {
      const detail = event.detail?.trim()
      sections.push(
        `### Tool: ${event.title} (${event.status})${detail ? `\n\n${detail}` : ""}`
      )
    }

    const requests = Array.isArray(message.agentRequests)
      ? message.agentRequests
          .map((value) => agentRequestFromValue(value))
          .filter((value): value is AgentRequest => value !== undefined)
      : []
    for (const request of requests)
      sections.push(
        `### Agent request: ${request.title || request.method} (${request.status})\n\n${request.details}`
      )
  }
  return `${sections.join("\n\n---\n\n")}\n`
}

/**
 * Names the downloaded transcript after the chat, keeping only letters,
 * digits, dashes and underscores.
 *
 * @param title - The chat's title.
 * @returns A filename ending in `.md`, "chat.md" when nothing usable is left.
 */
export function chatExportFilename(title: string | undefined): string {
  const name = (title || "chat")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-|-$/g, "")
  return `${name || "chat"}.md`
}
