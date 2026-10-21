import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { rememberWorkspace, restoreWorkspace, WorkspacePreferences } from "./workspace"
import type { WorkflowSession, WorkflowState } from "./contract"

function fixture(explicit?: string) {
  const state: { -readonly [Key in keyof WorkflowState]: WorkflowState[Key] } = {
    projects: [],
    servers: [],
    sessions: [],
    selectedProject: explicit,
  }
  const calls: { directory: string; select?: boolean }[] = []
  const remembered: WorkflowSession[] = []
  let turns = 0
  const bridge = {
    state: () => state,
    async project(directory: string, input: { select?: boolean } = {}) {
      calls.push({ directory, select: input.select })
      if (directory === "/missing") throw new Error("ENOENT")
      if (!state.projects.some((project) => project.directory === directory)) {
        state.projects = [...state.projects, { directory, name: directory, phase: "idle", messages: [], tasks: [] }]
        state.servers = [
          ...state.servers,
          { id: `openagi:${directory.slice(1)}`, directory, name: directory, state: "connected" },
        ]
      }
      if (input.select !== false) state.selectedProject = directory
    },
    rememberSessions(sessions: readonly WorkflowSession[]) {
      const valid = sessions.filter(
        (session) =>
          state.projects.some((project) => project.directory === session.directory) &&
          state.servers.some((server) => server.directory === session.directory && server.id === session.serverId),
      )
      remembered.push(...valid)
      state.sessions = valid.map((session) => ({ ...session, focus: false }))
    },
    run() {
      turns++
    },
    forget(directory: string) {
      state.projects = state.projects.filter((project) => project.directory !== directory)
      state.servers = state.servers.filter((server) => server.directory !== directory)
      state.sessions = state.sessions.filter((session) => session.directory !== directory)
      if (state.selectedProject === directory) state.selectedProject = undefined
    },
  }
  return { bridge, state, calls, remembered, turns: () => turns }
}
const signal = () => new AbortController().signal
const worker = { serverId: "openagi:a", directory: "/a", sessionId: "ses_worker", mode: "build", label: "Worker" }

describe("OpenAGI native workspace restoration", () => {
  test("restores backend ownership and historical selection without starting any operation", async () => {
    const world = fixture()
    const prefs = await restoreWorkspace(
      world.bridge,
      { directories: ["/a", "/b", "/a"], selectedProject: "/b", sessions: [worker] },
      signal(),
    )
    expect(world.calls).toEqual([
      { directory: "/a", select: false },
      { directory: "/b", select: false },
      { directory: "/b", select: undefined },
    ])
    expect(prefs.directories).toEqual(["/a", "/b"])
    expect(prefs.selectedProject).toBe("/b")
    expect(prefs.sessions).toEqual([worker])
    expect(world.state.sessions[0]?.focus).toBe(false)
    expect(world.turns()).toBe(0)
    expect(world.state.projects.every((project) => project.phase === "idle" && project.messages.length === 0)).toBe(
      true,
    )
  })
  test("a CLI/Finder project wins over historical selection", async () => {
    const world = fixture("/cli")
    await world.bridge.project("/cli")
    world.calls.length = 0
    const prefs = await restoreWorkspace(
      world.bridge,
      { directories: ["/a"], selectedProject: "/a", sessions: [] },
      signal(),
    )
    expect(world.calls).toEqual([{ directory: "/a", select: false }])
    expect(prefs.selectedProject).toBe("/cli")
    expect(world.turns()).toBe(0)
  })
  test("a new explicit selection made during restoration is not overwritten", async () => {
    const world = fixture("/cli")
    await world.bridge.project("/cli")
    const project = world.bridge.project
    world.bridge.project = async (directory, input) => {
      await project(directory, input)
      if (directory === "/a") await project("/new-cli")
    }
    const prefs = await restoreWorkspace(
      world.bridge,
      { directories: ["/a"], selectedProject: "/a", sessions: [] },
      signal(),
    )
    expect(prefs.selectedProject).toBe("/new-cli")
    expect(world.turns()).toBe(0)
  })
  test("missing folders and their session metadata are pruned while other projects restore", async () => {
    const world = fixture()
    const prefs = await restoreWorkspace(
      world.bridge,
      {
        directories: ["/missing", "/a"],
        selectedProject: "/missing",
        sessions: [worker, { ...worker, directory: "/missing" }],
      },
      signal(),
    )
    expect(prefs.directories).toEqual(["/a"])
    expect(prefs.selectedProject).toBeUndefined()
    expect(prefs.sessions).toEqual([worker])
    expect(world.turns()).toBe(0)
  })
  test("a forgotten project and its Worker sessions cannot reappear on the next startup", async () => {
    const world = fixture()
    await restoreWorkspace(
      world.bridge,
      { directories: ["/a", "/b"], selectedProject: "/a", sessions: [worker] },
      signal(),
    )
    world.bridge.forget("/a")
    const saved = rememberWorkspace(world.state)
    const next = fixture()
    await restoreWorkspace(next.bridge, saved, signal())
    expect(next.state.projects.map((project) => project.directory)).toEqual(["/b"])
    expect(next.state.sessions).toEqual([])
    expect(next.turns()).toBe(0)
  })
  test("official storage schema and writer keep no keys, transcript or replayed focus", () => {
    const world = fixture()
    world.state.projects = [
      {
        directory: "/a",
        name: "A",
        phase: "running",
        messages: [{ id: "m", role: "user", text: "private text", at: "now" }],
        tasks: [],
      },
    ]
    world.state.sessions = [{ ...worker, focus: true, apiKey: "secret" } as WorkflowSession]
    const saved = rememberWorkspace(world.state)
    const encoded = Schema.encodeSync(WorkspacePreferences)(saved)
    expect(encoded.sessions).toEqual([worker])
    expect(JSON.stringify(encoded)).not.toContain("secret")
    expect(JSON.stringify(encoded)).not.toContain("private text")
    expect(JSON.stringify(encoded)).not.toContain("focus")
    expect(JSON.stringify(encoded)).not.toContain("running")
  })
  test("extension shutdown aborts restoration before it can select or replay saved metadata", async () => {
    const world = fixture()
    const controller = new AbortController()
    const project = world.bridge.project
    world.bridge.project = async (directory, input) => {
      await project(directory, input)
      controller.abort()
    }
    await expect(
      restoreWorkspace(
        world.bridge,
        { directories: ["/a", "/b"], selectedProject: "/b", sessions: [worker] },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(world.calls).toEqual([{ directory: "/a", select: false }])
    expect(world.remembered).toEqual([])
    expect(world.turns()).toBe(0)
  })
})
