import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import type { LocalProject } from "@/shell/state/layout"
import { buildHomeSessionRecords, homeSessionConnections, homeSessionLocation, homeSessionSearchKey } from "./records"
import { ServerConnection } from "@/runtime/server/registry"

const session = (id: string, directory: string, projectID: string) =>
  ({
    id,
    projectID,
    title: id,
    location: { directory },
    time: { created: 1, updated: 1 },
  }) as SessionInfo

describe("buildHomeSessionRecords", () => {
  const opened = { id: "project-a", worktree: "/repo/a", expanded: true } as LocalProject
  const sessions = [session("a", "/repo/a", "project-a"), session("b", "/repo/b", "project-b")]

  test("includes sessions outside added projects when unfiltered", () => {
    const records = buildHomeSessionRecords({
      sources: () => [{ server: ServerConnection.Key.make("sidecar"), sessions, projects: [opened] }],
      projectDirectories: () => undefined,
    })

    expect(records.map((record) => record.session.id)).toEqual(["a", "b"])
    expect(records[1]?.project).toMatchObject({ id: "project-b", worktree: "/repo/b", expanded: false })
  })
  test("shows the workflow once and keeps unrelated native conversations", () => {
    const main = {
      ...session("ses_main", "/repo/a", "project-a"),
      metadata: { openagi: { kind: "workflow", directory: "/repo/a" } },
    }
    const worker = {
      ...session("ses_worker", "/repo/a/.openagi/worktrees/task", "project-a"),
      metadata: { openagi: { kind: "module", mainSessionId: "ses_main", directory: "/repo/a" } },
    }
    const records = buildHomeSessionRecords({
      sources: () => [
        {
          server: ServerConnection.Key.make("openagi:project"),
          sessions: [main, worker, session("ses_chat", "/repo/a", "project-a")],
          projects: [opened],
        },
      ],
      projectDirectories: () => undefined,
    })
    expect(records.map((record) => record.session.id)).toEqual(["ses_chat", "ses_main"])
  })

  test("filters sessions when a project is selected", () => {
    const records = buildHomeSessionRecords({
      sources: () => [{ server: ServerConnection.Key.make("sidecar"), sessions, projects: [opened] }],
      projectDirectories: () => ["/repo/a"],
    })

    expect(records.map((record) => record.session.id)).toEqual(["a"])
  })

  test("labels a worktree session with its project before that project's inventory has loaded", () => {
    const records = buildHomeSessionRecords({
      sources: () => [
        {
          server: ServerConnection.Key.make("sidecar"),
          sessions: [session("w", "/repo/a/.worktrees/feature", "project-a")],
          projects: [{ ...opened, name: "Project A" }],
        },
      ],
      projectDirectories: () => undefined,
    })

    expect(records[0]?.project).toMatchObject({ id: "project-a", worktree: "/repo/a" })
    expect(records[0]?.projectName).toBe("Project A")
  })

  test("prefers the added project whose directory matches over a sibling entry with the same ID", () => {
    const nested = { id: "project-a", worktree: "/repo/a/packages/app", expanded: true } as LocalProject

    const records = buildHomeSessionRecords({
      sources: () => [
        {
          server: ServerConnection.Key.make("sidecar"),
          sessions: [session("n", "/repo/a/packages/app", "project-a")],
          projects: [opened, nested],
        },
      ],
      projectDirectories: () => undefined,
    })

    expect(records[0]?.project.worktree).toBe("/repo/a/packages/app")
  })

  test("orders by update time and uses the id only to break equal timestamps", () => {
    const at = (id: string, updated: number) => ({
      ...session(id, "/repo/a", "project-a"),
      time: { created: 1, updated },
    })

    const records = buildHomeSessionRecords({
      sources: () => [
        {
          server: ServerConnection.Key.make("sidecar"),
          sessions: [at("ses_z", 2), at("ses_old", 1), at("ses_a", 2)],
          projects: [opened],
        },
      ],
      projectDirectories: () => undefined,
    })

    expect(records.map((record) => record.session.id)).toEqual(["ses_a", "ses_z", "ses_old"])
  })
})

test("homeSessionLocation returns the worktree directory name and branch when known", () => {
  expect(homeSessionLocation("/repo/.worktrees/crisp-cactus", "feature/home")).toEqual({
    worktree: "crisp-cactus",
    branch: "feature/home",
  })
  expect(homeSessionLocation("/repo/.worktrees/crisp-cactus")).toEqual({ worktree: "crisp-cactus", branch: undefined })
})

describe("project session feed", () => {
  const base: ServerConnection.Any = { type: "sidecar", variant: "base", http: { url: "http://localhost:1" } }
  const project = (key: string, directory: string): ServerConnection.Any => ({
    type: "extension",
    key,
    extension: "openagi",
    presentation: "project",
    projectDirectory: directory,
    state: "ready",
    connecting: false,
    authenticationRequired: false,
    managed: false,
    http: { url: "http://localhost:2" },
  })
  const a = project("openagi:a", "/repo/a")
  const b = project("openagi:b", "/repo/b")

  test("aggregates project connections while retaining the original focused-server fallback", () => {
    expect(homeSessionConnections({ connections: [base, a, b], focused: base, directory: undefined })).toEqual([a, b])
    expect(homeSessionConnections({ connections: [base], focused: base, directory: undefined })).toEqual([base])
    expect(homeSessionConnections({ connections: [base, a, b], focused: b, directory: "/repo/b" })).toEqual([b])
    expect(
      homeSessionConnections({ connections: [base], focused: base, directory: undefined, projectMode: true }),
    ).toEqual([])
  })

  test("keeps same-ID sessions distinct across backends, scopes by directory, and drops removed backends", () => {
    const sources = [a, b].map((conn) => ({
      server: ServerConnection.key(conn),
      sessions: [session("ses_shared", ServerConnection.projectDirectory(conn)!, "p")],
      projects: [] as LocalProject[],
    }))
    const all = buildHomeSessionRecords({ sources: () => sources, projectDirectories: () => undefined })

    expect(all.map((record) => String(record.server))).toEqual(["openagi:a", "openagi:b"])
    expect(new Set(all.map(homeSessionSearchKey)).size).toBe(2)
    expect(
      buildHomeSessionRecords({ sources: () => sources, projectDirectories: () => ["/repo/b"] }).map((record) =>
        String(record.server),
      ),
    ).toEqual(["openagi:b"])
    expect(
      buildHomeSessionRecords({ sources: () => sources.slice(1), projectDirectories: () => undefined }).map((record) =>
        String(record.server),
      ),
    ).toEqual(["openagi:b"])
  })
})
