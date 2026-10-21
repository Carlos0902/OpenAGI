import type { SessionInfo } from "@opencode/client/promise"

export function workflowSessionMetadata(session: SessionInfo | undefined) {
  const metadata = session?.metadata?.openagi
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
  if (metadata.kind !== "workflow" && metadata.kind !== "module") return
  if (typeof metadata.directory !== "string") return
  return {
    kind: metadata.kind,
    directory: metadata.directory,
    mainSessionId:
      metadata.kind === "workflow"
        ? session?.id
        : typeof metadata.mainSessionId === "string"
          ? metadata.mainSessionId
          : undefined,
  }
}

/** Validate the narrow local navigation event before handing control to the original tab manager. */
export function openagiSessionTarget(
  detail: unknown,
): { serverId: string; sessionId: string; directory: string } | undefined {
  if (!detail || typeof detail !== "object") return
  const value = detail as { serverId?: unknown; sessionId?: unknown; mainSessionId?: unknown; directory?: unknown }
  if (typeof value.serverId !== "string" || typeof value.sessionId !== "string" || typeof value.directory !== "string")
    return
  if (!/^openagi:[a-zA-Z0-9._-]+$/.test(value.serverId) || !/^ses[a-zA-Z0-9_-]+$/.test(value.sessionId)) return
  if (
    value.mainSessionId !== undefined &&
    (typeof value.mainSessionId !== "string" || !/^ses[a-zA-Z0-9_-]+$/.test(value.mainSessionId))
  )
    return
  const directory = value.directory
  if (!directory || /[\u0000\r\n]/.test(directory)) return
  const absolute =
    directory.startsWith("/") || /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\]+\\[^\\]+/.test(directory)
  if (!absolute || directory.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) return
  return { serverId: value.serverId, sessionId: value.mainSessionId ?? value.sessionId, directory }
}
