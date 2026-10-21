import type { SessionInfo } from "@opencode/client/promise"
import type { LocalProject } from "@/shell/state/layout"
import { displayName } from "@opencode/ui/project-avatar"
import { compareSessionTime } from "@/shell/layout/helpers"
import { pathKey } from "@/workspaces/path-key"
import { getFilename } from "@opencode/util/path"
import { ServerConnection } from "@/runtime/server/registry"
import { workflowSessionMetadata } from "@/runtime/extension/openagi-session"

export type HomeSessionRecord = {
  server: ServerConnection.Key
  session: SessionInfo
  project: LocalProject
  projectName: string
}

export function homeSessionLocation(directory: string, branch?: string) {
  return { worktree: getFilename(directory) || directory, branch }
}

export function buildHomeSessionRecords(input: {
  sources: () => {
    server: ServerConnection.Key
    sessions: SessionInfo[]
    projects: LocalProject[]
    resolveProject?: (session: SessionInfo) => LocalProject | undefined
  }[]
  projectDirectories: () => string[] | undefined
}) {
  const selected = input.projectDirectories()
  const directories = selected ? new Set(selected.map(pathKey)) : undefined

  return input
    .sources()
    .flatMap((source) => {
      const visible = source.sessions.filter((session) => workflowSessionMetadata(session)?.kind !== "module")
      const sessions = directories
        ? visible.filter((session) => directories.has(pathKey(session.location.directory)))
        : visible

      // Session IDs belong to a backend. Deduplicate its index and live data without collapsing sibling projects.
      return [...new Map(sessions.map((session) => [session.id, session] as const)).values()].map((session) => {
        const project = source.resolveProject?.(session) ??
          homeProjectForSession(session, source.projects) ?? {
            id: session.projectID,
            worktree: session.location.directory,
            expanded: false,
          }

        return { server: source.server, session, project, projectName: displayName(project) }
      })
    })
    .sort((a, b) => compareSessionTime(a.session, b.session) || a.server.localeCompare(b.server))
}

export function homeSessionConnections(input: {
  connections: ServerConnection.Any[]
  focused: ServerConnection.Any | undefined
  directory: string | undefined
  projectMode?: boolean
}) {
  if (input.directory) return input.focused ? [input.focused] : []
  const projects = input.connections.filter(ServerConnection.project)

  return input.projectMode || projects.length > 0 ? projects : input.focused ? [input.focused] : []
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${encodeURIComponent(record.server)}:${encodeURIComponent(pathKey(record.session.location.directory))}:${record.session.id}`
}

// Worktree inventories load on demand, so a worktree session may not match any directory yet;
// the session's project ID still identifies its added project.
export function homeProjectForSession<T extends { id?: string; worktree: string; sandboxes?: readonly string[] }>(
  session: SessionInfo,
  projects: readonly T[],
) {
  const directory = pathKey(session.location.directory)

  return (
    projects.find(
      (item) =>
        pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
    ) ?? projects.find((item) => item.id === session.projectID)
  )
}
