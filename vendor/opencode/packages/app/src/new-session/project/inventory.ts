import { isOpenAGI } from "@/runtime/product"
import { ServerConnection } from "@/runtime/server/registry"
import type { ServerCtx } from "@/runtime/server/runtime"
import { serverName } from "@/runtime/server/registry"
import { pathKey } from "@/workspaces/path-key"
import type { PromptProject } from "./selector"

/** Native project choices keep their routing key while internal transports remain ungrouped project rows. */
export function composerProjectInventory(
  connections: readonly ServerConnection.Any[],
  contextFor: (connection: ServerConnection.Any) => { projects: Pick<ServerCtx["projects"], "list"> },
  managed: boolean,
): PromptProject[] {
  const internal = connections.some(ServerConnection.project)

  return connections.flatMap((connection) => {
    if (isOpenAGI && !ServerConnection.project(connection) && !ServerConnection.builtin(connection)) return []
    if ((managed || isOpenAGI) && internal && ServerConnection.builtin(connection)) return []
    const directory = ServerConnection.projectDirectory(connection)
    const server = { key: ServerConnection.key(connection), name: serverName(connection), presentation: isOpenAGI ? "project" : connection.type === "extension" ? connection.presentation : undefined }

    return contextFor(connection).projects.list().flatMap((project) =>
      directory && pathKey(directory) !== pathKey(project.worktree) ? [] : [{ ...project, server }],
    )
  })
}

/** Only public server connections belong in the selector's server groups and server action submenu. */
export function promptProjectServers(projects: readonly PromptProject[]) {
  const result = new Map<string, NonNullable<PromptProject["server"]>>()

  if (isOpenAGI) return Array.from(result.values())

  for (const project of projects) {
    const server = project.server

    if (server && server.presentation !== "project" && !result.has(server.key)) result.set(server.key, server)
  }

  return Array.from(result.values())
}
