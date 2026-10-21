import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowState } from "./contract"

describe("OpenAGI native IPC state", () => {
  test("passes ephemeral local backend auth while dropping provider credentials from settings snapshots", () => {
    const state = Schema.decodeUnknownSync(WorkflowState)({
      projects: [
        {
          directory: "/project",
          name: "Project",
          phase: "idle",
          messages: [],
          tasks: [],
          config: { heavy: "primary/heavy", light: "primary/light", apiKey: "provider-secret", jevKey: "jev-secret" },
          usage: { total: 18, requests: 1, unreported: 0, models: [{ providerID: "primary", modelID: "heavy", input: 10, output: 2, reasoning: 3, cache: { read: 2, write: 1 }, total: 18, requests: 1, unreported: 0 }] },
        },
      ],
      servers: [
        {
          id: "openagi:project",
          name: "Project",
          directory: "/project",
          state: "connected",
          http: { url: "http://127.0.0.1:1234", username: "opencode", password: "ephemeral-local-password" },
        },
      ],
      sessions: [
        { serverId: "openagi:project", directory: "/project", sessionId: "ses_123", mode: "observe", label: "Tutor" },
      ],
    })

    expect(state.projects[0]?.config).toEqual({ heavy: "primary/heavy", light: "primary/light" })
    expect(state.projects[0]?.usage?.models[0]?.cache).toEqual({ read: 2, write: 1 })
    expect(state.projects[0]?.usage?.total).toBe(18)
    expect(state.servers[0]?.http?.password).toBe("ephemeral-local-password")
    expect(JSON.stringify(state)).not.toContain("provider-secret")
    expect(JSON.stringify(state)).not.toContain("jev-secret")
  })
  test("acceptance evidence remains available without fabricating native session events", () => {
    const state = Schema.decodeUnknownSync(WorkflowState)({
      projects: [
        {
          directory: "/project",
          name: "Project",
          phase: "idle",
          messages: [],
          tasks: [
            {
              id: "task",
              title: "A feature",
              description: "Change",
              status: "validated",
              priority: 1,
              acceptanceCriteria: ["Works"],
              rationale: "Needed",
              run: {
                status: "validated",
                sessionId: "ses_worker",
                checks: [{ name: "Build", ok: true }],
                acceptance: "Passed",
              },
            },
          ],
        },
      ],
      servers: [],
      sessions: [],
    })

    expect(state.projects[0]?.tasks[0]?.run?.checks).toEqual([{ name: "Build", ok: true }])
    expect(state.projects[0]?.tasks[0]?.run?.acceptance).toBe("Passed")
    expect(state.sessions).toEqual([])
  })
  test("an offline saved project keeps its original server identity and Worker session ownership without credentials", () => {
    const state = Schema.decodeUnknownSync(WorkflowState)({
      projects: [{ directory: "/project", name: "Project", phase: "idle", messages: [], tasks: [] }],
      servers: [{ id: "openagi:project", name: "Project", directory: "/project", state: "stopped" }],
      sessions: [
        {
          serverId: "openagi:project",
          directory: "/project",
          sessionId: "ses_worker",
          mode: "build",
          label: "Worker",
          focus: false,
        },
      ],
    })

    expect(state.servers[0]).toEqual({
      id: "openagi:project",
      name: "Project",
      directory: "/project",
      state: "stopped",
    })
    expect(state.sessions[0]?.serverId).toBe("openagi:project")
    expect(state.sessions[0]?.focus).toBe(false)
    expect(state.servers[0]?.http).toBeUndefined()
  })
})
