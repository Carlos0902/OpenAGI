import { expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { composerProjectInventory, promptProjectServers } from "./inventory"

const local: ServerConnection.Sidecar = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } }

const remote: ServerConnection.Http = { type: "http", displayName: "Build host", http: { url: "https://build.example.test" } }

const game: ServerConnection.Extension = {
  type: "extension", key: "workflow:game", extension: "workflow", presentation: "project", projectDirectory: "/game",
  state: "ready", connecting: false, authenticationRequired: false, managed: false,
  displayName: "Internal engine", http: { url: "http://127.0.0.1:1234" },
}

const projects = (connection: ServerConnection.Any) => ({
  projects: {
    list: () => connection === game
      ? [{ worktree: "/game", expanded: true }, { worktree: "/game/worktree/task", expanded: true }]
      : [{ worktree: connection === local ? "/legacy" : "/remote", expanded: true }],
  },
})

test("OpenAGI composer lists owning project folders without exposing legacy connections or worker worktrees", () => {
  const rows = composerProjectInventory([local, game, remote], projects, true)
  expect(rows.map((project) => project.worktree)).toEqual(["/game"])
  expect(rows[0].server?.key).toBe(game.key)
  expect(promptProjectServers(rows)).toEqual([])
  expect(promptProjectServers(rows).some((server) => server.key === game.key)).toBe(false)
})

test("OpenAGI loading its project manager retains local folders without exposing old remote connections", () => {
  const rows = composerProjectInventory([local, remote], projects, false)
  expect(rows.map((project) => project.worktree)).toEqual(["/legacy"])
  expect(rows[0].server?.key).toBe("sidecar")
  expect(promptProjectServers(rows)).toEqual([])
})
