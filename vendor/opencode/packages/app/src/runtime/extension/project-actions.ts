import type { ProjectManager, ProjectTarget } from "@opencode/gui-extensions/sdk"
import { ServerConnection } from "../server/registry"

export type ResolvedProjectTarget = { server: ServerConnection.Any; directory: string }

/** The same native action contract serves Home, menus, draft selection and project settings. */
export function createManagedProjectActions(input: {
  managers: () => readonly ProjectManager[]
  resolve: (target: ProjectTarget) => Promise<ResolvedProjectTarget>
  closeTabs: (key: ServerConnection.Key) => void
}) {
  const manager = (connection: ServerConnection.Any) => input.managers().find(item => item.handles({server:ServerConnection.key(connection), builtin:ServerConnection.builtin(connection)}))
  return {
    active: () => input.managers().length > 0,
    entries: () => input.managers().flatMap(item => item.entries ?? []),
    handles: (connection: ServerConnection.Any) => !!manager(connection),
    choose: async (connection: ServerConnection.Any) => { const target = await manager(connection)?.choose(); return target ? input.resolve(target) : undefined },
    add: async (connection: ServerConnection.Any, directories: readonly string[]) => {
      const targets = await manager(connection)?.add(directories) ?? []
      return Promise.all(targets.map(input.resolve))
    },
    select: (connection: ServerConnection.Any, directory: string) => Promise.resolve(manager(connection)?.select({server:ServerConnection.key(connection),directory})),
    start: (connection: ServerConnection.Any, directory: string) => manager(connection)?.start({server:ServerConnection.key(connection),directory}) ?? Promise.resolve(),
    close: (connection: ServerConnection.Any, directory: string) => manager(connection)?.close({server:ServerConnection.key(connection),directory}) ?? Promise.resolve(),
    remove: async (connection: ServerConnection.Any, directory: string) => {
      const handler = manager(connection)
      if (!handler) return
      await handler.remove({server:ServerConnection.key(connection),directory})
      input.closeTabs(ServerConnection.key(connection))
    },
  }
}

export function shouldRegisterProject(target: ProjectTarget, closed: readonly string[], registered: ReadonlySet<string>) {
  const key = `${target.server}\0${target.directory}`
  return !registered.has(key) && !closed.includes(target.directory)
}
