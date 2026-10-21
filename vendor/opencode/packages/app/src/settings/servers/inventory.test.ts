import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import type { ExtensionServer } from "@/runtime/extension/servers"
import { settingsProjectInventory, settingsProjects, settingsServers, settingsServerManagement } from "./inventory"

const ssh: ExtensionServer = {
  key: "ssh:build",
  extension: "ssh",
  entry: { id: "build", name: "Build server", state: "stopped" },
}

const connection: ServerConnection.Extension = {
  type: "extension",
  key: "ssh:build",
  extension: "ssh",
  state: "stopped",
  connecting: false,
  authenticationRequired: false,
  managed: true,
  displayName: "Build server",
  http: { url: "http://127.0.0.1:4000", password: "secret" },
}

test("settings project inventory reads metadata without acquiring directory stores", () => {
  const projects = Array.from({ length: 40 }, (_, index) => ({
    id: `project-${index}`,
    worktree: `/projects/${index}`,
    name: `Project ${index}`,
    icon: { color: "orange" },
    commands: { start: "bun install" },
    time: { created: 1, updated: 1, active: 1 },
    sandboxes: [],
    worktrees: [],
  }))

  const tracked = { ...projects[0], expanded: true, icon: { override: "local-icon" } }

  const inventory = settingsProjects({
    projects: { list: () => [tracked], closed: () => [projects[1].worktree] },
    sync: { data: { project: projects } },
  })

  expect(inventory).toHaveLength(39)
  expect(inventory[0]).toBe(tracked)
  expect(inventory.some((project) => project.id === projects[1].id)).toBe(false)
  expect(inventory[1]).toEqual({ ...projects[2], expanded: false })
  expect(inventory[38]).toEqual({ ...projects[39], expanded: false })
})

describe("settings server inventory", () => {
  test("includes contributed servers before they connect", () => {
    expect(settingsServers([], [ssh])).toEqual([
      {
        key: ServerConnection.Key.make("ssh:build"),
        name: "Build server",
        source: ssh,
      },
    ])
  })

  test("joins a ready contributed server to its live connection and withholds it while disconnected", () => {
    const ready = { ...ssh, entry: { ...ssh.entry, state: "ready" as const } }
    expect(settingsServers([connection], [ready])).toEqual([
      {
        key: ServerConnection.Key.make("ssh:build"),
        name: "Build server",
        connection,
        source: ready,
      },
    ])
    expect(settingsServers([connection], [ssh])[0].connection).toBeUndefined()
  })
})


test("internal project connections remain routable while server management excludes them", () => {
  const internal: ServerConnection.Extension = {
    ...connection, key: "workflow:game", extension: "workflow", presentation: "project", projectDirectory: "/game", state: "ready",
  }

  const source: ExtensionServer = {
    key: internal.key, extension: internal.extension,
    entry: { id: "game", name: "Game", state: "ready", presentation: "project", projectDirectory: "/game" },
  }

  const inventory = settingsServers([connection, internal], [ssh, source])
  expect(inventory.find((item) => item.key === internal.key)?.connection).toBe(internal)
  expect(settingsServerManagement(inventory).map((item) => String(item.key))).toEqual([connection.key])
  const stopped = { ...source, entry: { ...source.entry, state: "stopped" as const } }
  expect(settingsServerManagement(settingsServers([], [ssh, stopped])).map((item) => String(item.key))).toEqual([connection.key])
})

test("aggregated project rows keep their owning backend and exclude worker worktrees", () => {
  const local: ServerConnection.Sidecar = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4000" } }

  const internal: ServerConnection.Extension = {
    ...connection, key: "workflow:game", extension: "workflow", presentation: "project", projectDirectory: "/game", state: "ready",
  }

  const game = { worktree: "/game", expanded: true }
  const worker = { worktree: "/game/.worktrees/task", expanded: true }
  const other = { worktree: "/other", expanded: true }

  const context = (server: ServerConnection.Any) => ({
    projects: { list: () => server === internal ? [game, worker] : [game, other], closed: () => [] },
    sync: { data: { project: [] } },
  })

  const rows = settingsProjectInventory([local, internal], context)
  expect(rows.map((row) => row.project.worktree)).toEqual(["/game", "/other"])
  expect(rows[0].server).toBe(internal)
  expect(rows[1].server).toBe(local)
  expect(settingsProjectInventory([internal], () => ({
    projects: { list: () => [], closed: () => ["/game"] }, sync: { data: { project: [] } },
  }))).toHaveLength(0)
})
