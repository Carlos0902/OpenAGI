import { createMemo } from "solid-js"
import { ServerConnection, serverName, useServers } from "@/runtime/server/registry"
import { useExtensionServers, type ExtensionServer } from "@/runtime/extension/servers"
import type { ServerCtx } from "@/runtime/server/runtime"
import { pathKey } from "@/workspaces/path-key"
import type { LocalProject } from "@/shell/state/layout"

export function settingsProjects(context: {
  projects: Pick<ServerCtx["projects"], "list" | "closed">
  sync: { data: Pick<ServerCtx["sync"]["data"], "project"> }
}) {
  const tracked = context.projects.list()
  const paths = new Set(tracked.map((project) => pathKey(project.worktree)))
  const closed = new Set(context.projects.closed().map(pathKey))

  return [
    ...tracked,
    // Inventory reads must not allocate directory stores: async cache hydration can trigger an eviction/reload loop.
    ...context.sync.data.project
      .filter((project) => !paths.has(pathKey(project.worktree)) && !closed.has(pathKey(project.worktree)))
      .map((project) => ({ ...project, expanded: false })),
  ]
}

export type SettingsServer = {
  key: ServerConnection.Key
  name: string
  connection?: ServerConnection.Any
  /** The extension entry of a contributed server, e.g. SSH or WSL. */
  source?: ExtensionServer
}

export function settingsServers(connections: readonly ServerConnection.Any[], sources: readonly ExtensionServer[]) {
  const byKey = new Map(sources.map((item) => [item.key, item]))
  const connected = new Set<string>(connections.map(ServerConnection.key))

  return [
    ...connections.map((connection): SettingsServer => {
      const key = ServerConnection.key(connection)
      const source = byKey.get(key)

      return {
        key,
        name: source?.entry.name ?? (serverName(connection) || key),
        connection: source && source.entry.state !== "ready" ? undefined : connection,
        source,
      }
    }),
    ...sources.flatMap((item): SettingsServer[] => connected.has(item.key) ? [] : [{
      key: ServerConnection.Key.make(item.key),
      name: item.entry.name,
      source: item,
    }]),
  ]
}

// A restored settings route must not be redirected against a partial list: contributed servers load asynchronously.
export function useSettingsServersLoaded() {
  const servers = useServers()
  const extensions = useExtensionServers()

  return () => servers.hydrated() && extensions.ready()
}

/** Server management excludes internal project transports; routing keeps the full inventory. */
export function settingsServerManagement(inventory: readonly SettingsServer[]) {
  return inventory.filter((item) =>
    item.source?.entry.presentation !== "project" && (!item.connection || !ServerConnection.project(item.connection)),
  )
}

export function useSettingsServerManagement() {
  const inventory = useSettingsServers()

  return createMemo(() => settingsServerManagement(inventory()))
}

export function useSettingsServers() {
  const servers = useServers()
  const extensions = useExtensionServers()

  return createMemo(() => settingsServers(servers.list, extensions.entries()))
}


export type SettingsProjectTarget = { key: string; server: ServerConnection.Any; project: LocalProject }

/** Each original project row keeps its backend; internal transports expose only their owning directory. */
export function settingsProjectInventory(
  connections: readonly ServerConnection.Any[],
  contextFor: (connection: ServerConnection.Any) => Parameters<typeof settingsProjects>[0],
) {
  const rows = new Map<string, SettingsProjectTarget>()

  for (const server of connections) {
    const directory = ServerConnection.projectDirectory(server)

    const projects = settingsProjects(contextFor(server))
      .filter((project) => !directory || pathKey(project.worktree) === pathKey(directory))

    for (const project of projects) {
      const key = pathKey(project.worktree)
      const previous = rows.get(key)

      if (previous && (!ServerConnection.project(server) || ServerConnection.project(previous.server))) continue
      rows.set(key, { key, server, project })
    }
  }

  return Array.from(rows.values())
}
