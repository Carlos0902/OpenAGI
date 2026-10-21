import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { homeProjectEntries, homeProjectEntryKey, moveHomeProjectOrder } from "./order"

const server = (key: string): ServerConnection.Any => ({
  type: "extension",
  extension: "openagi",
  key,
  presentation: "project",
  projectDirectory: `/repo/${key}`,
  state: "ready",
  connecting: false,
  authenticationRequired: false,
  managed: false,
  http: { url: "http://localhost:1" },
})

describe("Home project order", () => {
  const a = server("openagi:a")
  const b = server("openagi:b")
  const remote: ServerConnection.Any = { type: "http", http: { url: "https://remote.test" } }
  const inventory = [a, b, remote]
  const projects = (conn: ServerConnection.Any) => [
    { worktree: ServerConnection.projectDirectory(conn) ?? "/remote", expanded: true },
  ]

  test("moves across project backends and restores the flat order with each original owner", () => {
    const entries = homeProjectEntries({ servers: inventory, projects, order: [] })
    const order = moveHomeProjectOrder(entries, homeProjectEntryKey(entries[1]), 0)
    const restored = homeProjectEntries({ servers: [...inventory].reverse(), projects, order })

    expect(entries.map((entry) => ServerConnection.key(entry.server))).toEqual([
      ServerConnection.Key.make("openagi:a"),
      ServerConnection.Key.make("openagi:b"),
    ])
    expect(restored.map((entry) => ServerConnection.key(entry.server))).toEqual([
      ServerConnection.Key.make("openagi:b"),
      ServerConnection.Key.make("openagi:a"),
    ])
    expect(restored.map((entry) => entry.project.worktree)).toEqual(["/repo/openagi:b", "/repo/openagi:a"])
    expect(moveHomeProjectOrder(restored, homeProjectEntryKey(restored[0]), 1)).toEqual(
      entries.map(homeProjectEntryKey),
    )
  })

  test("reuses persisted order after metadata changes and retains distinct owners with matching paths", () => {
    const matching = () => [{ worktree: "/repo/shared", expanded: true }]
    const entries = homeProjectEntries({ servers: [a, b], projects: matching, order: [] })
    const order = moveHomeProjectOrder(entries, homeProjectEntryKey(entries[1]), 0)
    const changed = homeProjectEntries({
      servers: [a, { ...b, displayName: "Renamed project", http: { url: "http://localhost:2" } }],
      projects: matching,
      order,
    })

    expect(new Set(entries.map(homeProjectEntryKey)).size).toBe(2)
    expect(changed.map((entry) => String(ServerConnection.key(entry.server)))).toEqual(["openagi:b", "openagi:a"])
    expect(changed[0].server.http.url).toBe("http://localhost:2")
    expect(
      homeProjectEntries({ servers: [a], projects: matching, order }).map((entry) =>
        String(ServerConnection.key(entry.server)),
      ),
    ).toEqual(["openagi:a"])
  })
})
