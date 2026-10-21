import { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import { pathKey } from "@/workspaces/path-key"

export type HomeProjectEntry = { server: ServerConnection.Any; project: LocalProject }

export function homeProjectEntryKey(entry: HomeProjectEntry) {
  return `${encodeURIComponent(ServerConnection.key(entry.server))}:${encodeURIComponent(pathKey(entry.project.worktree))}`
}

export function homeProjectEntries(input: {
  servers: ServerConnection.Any[]
  projects: (server: ServerConnection.Any) => LocalProject[]
  order: readonly string[]
}) {
  const order = new Map(input.order.map((key, index) => [key, index]))

  return input.servers
    .filter(ServerConnection.project)
    .flatMap((server) => input.projects(server).map((project) => ({ server, project })))
    .sort(
      (a, b) =>
        (order.get(homeProjectEntryKey(a)) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(homeProjectEntryKey(b)) ?? Number.MAX_SAFE_INTEGER),
    )
}

export function moveHomeProjectOrder(entries: HomeProjectEntry[], key: string, index: number) {
  const current = entries.findIndex((entry) => homeProjectEntryKey(entry) === key)

  if (current === -1) return entries.map(homeProjectEntryKey)
  const next = entries.slice()
  const [entry] = next.splice(current, 1)
  next.splice(Math.max(0, Math.min(index, next.length)), 0, entry)

  return next.map(homeProjectEntryKey)
}
