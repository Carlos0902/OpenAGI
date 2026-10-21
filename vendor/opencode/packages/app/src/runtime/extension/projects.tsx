import { ProjectManager, type ProjectTarget } from "@opencode/gui-extensions/sdk"
import { createEffect, createMemo, createRoot, onCleanup } from "solid-js"
import { useExtensionHost } from "./host"
import { useGlobal } from "../server/runtime"
import { ServerConnection, useServers } from "../server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { createManagedProjectActions, shouldRegisterProject } from "./project-actions"
import { pathKey } from "@/workspaces/path-key"

/** Project contributions use the original stores, routes and tabs; transports stay internal. */
export function useProjectManagerActions() {
  const host = useExtensionHost()
  const global = useGlobal()
  const tabs = useTabs()
  const managers = createMemo(() => host.list(ProjectManager).toSorted((a,b) => (a.priority ?? 0) - (b.priority ?? 0)))
  const resolve = async (target: ProjectTarget) => {
    const immediate = global.servers.list().find(item => ServerConnection.key(item) === target.server)
    const connection = immediate ?? await new Promise<ServerConnection.Any>((done, reject) => createRoot(dispose => {
      const timer = setTimeout(() => { dispose(); reject(new Error("Project connection did not become available")) }, 15_000)
      createEffect(() => {
        const found = global.servers.list().find(item => ServerConnection.key(item) === target.server)
        if (!found) return
        clearTimeout(timer); dispose(); done(found)
      })
    }))
    const context = global.ensureServerCtx(connection)
    context.projects.open(target.directory)
    context.projects.touch(target.directory)
    return { server: connection, directory: target.directory }
  }
  return createManagedProjectActions({ managers, resolve, closeTabs: tabs.removeServer })
}

/** Initial project inventory is registered once; original recent/closed state has authority. */
export function ProjectManagerInventory() {
  const actions = useProjectManagerActions()
  const global = useGlobal()
  const servers = useServers()
  const seen = new Set<string>()
  createEffect(() => {
    if (!servers.hydrated()) return
    for (const target of actions.entries()) {
      const key = `${target.server}\0${pathKey(target.directory)}`
      if (seen.has(key)) continue
      const connection = global.servers.list().find(item => ServerConnection.key(item) === target.server)
      if (!connection) continue
      const context = global.ensureServerCtx(connection)
      const register = shouldRegisterProject({server:target.server,directory:pathKey(target.directory)}, context.projects.closed().map(pathKey), seen)
      seen.add(key)
      if (register) context.projects.open(target.directory)
    }
    const current = new Set(actions.entries().map(target => `${target.server}\0${pathKey(target.directory)}`))
    for (const key of seen) if (!current.has(key)) seen.delete(key)
  })
  onCleanup(() => seen.clear())
  return null
}
