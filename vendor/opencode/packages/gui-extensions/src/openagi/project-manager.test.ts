import { describe, expect, test } from "bun:test"
import type { ProjectTarget } from "../sdk"
import type { WorkflowState } from "./contract"
import { createWorkflowProjectManager } from "./project-manager"

function fixture() {
  const state: WorkflowState = {
    projects: ["/projects/a", "/projects/b"].map((directory) => ({
      directory,
      name: "Project",
      phase: "idle",
      messages: [],
      tasks: [],
    })),
    servers: ["a", "b"].map((id) => ({
      id: `openagi:${id}`,
      name: "Project",
      directory: `/projects/${id}`,
      state: "connected",
    })),
    sessions: [],
  }
  const events: string[] = []
  const selections: string[] = []
  const dialogs: string[] = []
  let selected = "/projects/a"
  let pick: ProjectTarget | null = { server: "openagi:b", directory: "/projects/b" }
  let runs = 0
  const controller = new AbortController()
  const api = {
    async project(input: { directory: string }) {
      const directory = input.directory === "/symlink-b" ? "/projects/b" : input.directory
      events.push(`project:${directory}`)
      return { server: `openagi:${directory.split("/").at(-1)}`, directory }
    },
    async pickProject() {
      events.push("picker")
      return pick
    },
    async pause(input: { directory: string }) {
      events.push(`pause:${input.directory}`)
    },
    async forget(input: { directory: string }) {
      events.push(`forget:${input.directory}`)
    },
    async run() {
      runs++
    },
  }
  const manager = createWorkflowProjectManager({
    state: () => state,
    client: () => api,
    select(directory) {
      selected = directory
      selections.push(directory)
      events.push(`select:${directory}`)
    },
    async start() {
      dialogs.push(selected)
      events.push(`dialog:${selected}`)
    },
    signal: controller.signal,
  })
  return {
    manager,
    api,
    events,
    selections,
    dialogs,
    controller,
    runs: () => runs,
    cancelPicker: () => {
      pick = null
    },
  }
}

describe("OpenAGI native ProjectManager", () => {
  test("owns original local project actions and known project connections without claiming remote sources", () => {
    const world = fixture()
    expect(world.manager.handles({ server: "sidecar", builtin: true })).toBe(true)
    expect(world.manager.handles({ server: "openagi:b", builtin: false })).toBe(true)
    expect(world.manager.handles({ server: "ssh:host", builtin: false })).toBe(false)
    expect(world.manager.handles({ server: "openagi:unknown", builtin: false })).toBe(false)
    expect(world.manager.entries).toEqual([
      { server: "openagi:a", directory: "/projects/a" },
      { server: "openagi:b", directory: "/projects/b" },
    ])
    expect(world.events).toEqual([])
    expect(world.runs()).toBe(0)
  })
  test("native picker returns the canonical owner target and selects it without a dialog or task run", async () => {
    const world = fixture()
    expect(await world.manager.choose()).toEqual({ server: "openagi:b", directory: "/projects/b" })
    expect(world.selections).toEqual(["/projects/b"])
    expect(world.dialogs).toEqual([])
    expect(world.runs()).toBe(0)
    world.cancelPicker()
    expect(await world.manager.choose()).toBeUndefined()
    expect(world.selections).toEqual(["/projects/b"])
  })
  test("multi-directory native Add Project deduplicates canonical targets and does not auto-start", async () => {
    const world = fixture()
    expect(await world.manager.add(["/projects/a", "/symlink-b", "/projects/b", "/symlink-b"])).toEqual([
      { server: "openagi:a", directory: "/projects/a" },
      { server: "openagi:b", directory: "/projects/b" },
    ])
    expect(world.selections).toEqual(["/projects/b"])
    expect(world.dialogs).toEqual([])
    expect(world.runs()).toBe(0)
  })
  test("a Home selection changes the workflow owner before Start opens the summary dialog", async () => {
    const world = fixture()
    await world.manager.select({ server: "openagi:b", directory: "/projects" })
    expect(world.selections).toEqual(["/projects/b"])
    expect(world.dialogs).toEqual([])
    world.events.length = 0
    await world.manager.start({ server: "openagi:b", directory: "/projects" })
    expect(world.events).toEqual(["project:/projects/b", "select:/projects/b", "dialog:/projects/b"])
    expect(world.dialogs).toEqual(["/projects/b"])
    expect(world.runs()).toBe(0)
  })
  test("Close and Remove follow backend ownership even when native rows show a canonical Git parent", async () => {
    const world = fixture()
    await world.manager.close({ server: "openagi:b", directory: "/projects" })
    await world.manager.remove({ server: "openagi:b", directory: "/projects" })
    expect(world.events).toEqual(["pause:/projects/b", "forget:/projects/b"])
    await world.manager.close({ server: "sidecar", directory: "/unregistered" })
    await world.manager.remove({ server: "sidecar", directory: "/unregistered" })
    expect(world.events).toHaveLength(2)
    expect(world.runs()).toBe(0)
  })
  test("a cancelled native project operation cannot start or select a late backend reply", async () => {
    const world = fixture()
    const project = world.api.project
    world.api.project = async (input) => {
      const target = await project(input)
      world.controller.abort()
      return target
    }
    await expect(world.manager.start({ server: "openagi:b", directory: "/projects/b" })).rejects.toThrow()
    expect(world.selections).toEqual([])
    expect(world.dialogs).toEqual([])
    expect(world.runs()).toBe(0)
  })
})
