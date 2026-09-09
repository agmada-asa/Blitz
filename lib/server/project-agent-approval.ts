/** Formats runtime approval requests and returns only the exact, explicitly reviewed grant. */
import type {
  CodexApprovalResponse,
  CodexServerRequest,
} from "./codex-app-server.ts"

/** Reads an unknown protocol object without accepting arrays or null. */
export function approvalRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Supported runtime approval methods; unknown methods never receive implicit approval. */
export function supportedProjectApproval(method: string): boolean {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ].includes(method)
}

/** Includes the exact command, permissions, or proposed file changes for the review panel. */
export function projectApprovalDetails(
  request: CodexServerRequest,
  item?: unknown
): string {
  const details = JSON.stringify(
    {
      request: request.params ?? {},
      ...(item ? { proposedChange: item } : {}),
    },
    null,
    2
  )
  if (details.length > 20_000)
    throw new Error(
      "This approval is too large to review. Ask the agent to split the operation."
    )
  return details
}

/** Grants one reviewed operation, or denies it; permission grants expire with the turn. */
export function projectApprovalResponse(
  request: CodexServerRequest,
  approved: boolean,
  optionId?: string
): CodexApprovalResponse {
  if (request.method === "item/permissions/requestApproval") {
    const permissions = approvalRecord(
      approvalRecord(request.params)?.permissions
    )
    const fileSystem = approvalRecord(permissions?.fileSystem)
    const network = approvalRecord(permissions?.network)
    return {
      permissions: approved
        ? {
            fileSystem: fileSystem ?? null,
            network: network?.enabled === true ? { enabled: true } : null,
          }
        : { fileSystem: null, network: null },
      scope: "turn",
    }
  }
  return {
    decision:
      approved && supportedProjectApproval(request.method)
        ? optionId === "acceptForSession"
          ? "acceptForSession"
          : "accept"
        : "decline",
  }
}
