import { describe, expect, test } from "bun:test"
import { closedWorkflowProject, shouldFocusWorkflowSession, workflowProjectForSession, workflowStatus } from "./lifecycle"
import type { WorkflowState } from "./contract"

const servers = [
  { id: "openagi:project_a", name: "Project", directory: "/projects/a", state: "connected" as const },
  { id: "openagi:project_b", name: "Project", directory: "/projects/b", state: "connected" as const },
]

describe("OpenAGI native project lifecycle", () => {
  test("an orchestration error awaiting retry overrides stale running activity; retry and pause report their real states", () => {
    const project = { directory: "/repo", name: "Project", phase: "running" as const, activity: "preparing" as const, messages: [], tasks: [] }
    const prompt = { id: "retry", text: "Retry", secret: false }
    expect(workflowStatus({ ...project, prompt, error: "Git failed" })).toBe("recovery")
    expect(workflowStatus({ ...project, prompt })).toBe("pending")
    expect(workflowStatus(project)).toBe("stage.preparing")
    expect(workflowStatus({ ...project, phase: "idle" })).toBe("idle")
    expect(workflowStatus({ ...project, phase: "stopping", prompt, error: "Git failed" })).toBe("stopping")
  })
  test("routes a native close to exactly its backend even when names are identical", () => {
    expect(closedWorkflowProject({ server: "openagi:project_b", directory: "/projects/b" }, servers)).toBe(
      "/projects/b",
    )
    expect(closedWorkflowProject({ server: "openagi:project_a", directory: "/projects/a" }, servers)).toBe(
      "/projects/a",
    )
  })
  test("uses isolated server ownership when native Close reports a canonical Git parent directory", () => {
    expect(closedWorkflowProject({ server: "openagi:project_b", directory: "/projects" }, servers)).toBe("/projects/b")
    expect(closedWorkflowProject({ server: "openagi:project_b", directory: "/projects/a" }, servers)).toBe("/projects/b")
  })
  test("ignores unrelated servers, removed backends and malformed events", () => {
    for (const event of [
      null,
      "close",
      {},
      { server: "sidecar", directory: "/projects/a" },
      { server: "ssh:host", directory: "/projects/a" },
      { server: "openagi:removed", directory: "/projects/a" },
      { server: "openagi:project_a", directory: undefined },
    ])
      expect(closedWorkflowProject(event, servers)).toBeUndefined()
  })
})

describe("OpenAGI native session ownership", () => {
  const project = (directory: string) => ({
    directory,
    name: "Project",
    phase: "running" as const,
    messages: [],
    tasks: [],
  })
  const state: WorkflowState = {
    projects: [project("/repo"), project("/repo/subproject")],
    servers: [{ id: "openagi:subproject", name: "Project", directory: "/repo/subproject", state: "connected" }],
    sessions: [
      {
        serverId: "openagi:subproject",
        directory: "/repo/subproject",
        sessionId: "ses_worker",
        mode: "build",
        label: "Worker",
      },
    ],
  }
  test("selects the owning project before the canonical Git parent for a Worker in an isolated worktree", () => {
    const session = {
      id: "ses_worker",
      server: { id: "openagi:subproject" },
      directory: "/repo/subproject/.openagi/worktrees/task",
      project: { worktree: "/repo" },
    }
    expect(workflowProjectForSession(state, session)?.directory).toBe("/repo/subproject")
  })
  test("a native session created manually in the backend still maps to the backend project", () => {
    expect(
      workflowProjectForSession(state, {
        id: "ses_manual",
        server: { id: "openagi:subproject" },
        directory: "/repo",
        project: { worktree: "/repo" },
      })?.directory,
    ).toBe("/repo/subproject")
  })
  test("a removed OpenAGI backend never falls back to a different project's questions", () => {
    expect(
      workflowProjectForSession(state, {
        id: "ses_old",
        server: { id: "openagi:removed" },
        directory: "/repo",
        project: { worktree: "/repo" },
      }),
    ).toBeUndefined()
  })
  test("unrelated original native sessions prefer their exact directory over the canonical Git parent", () => {
    expect(
      workflowProjectForSession(state, {
        id: "ses_original",
        server: { id: "sidecar" },
        directory: "/repo/subproject",
        project: { worktree: "/repo" },
      })?.directory,
    ).toBe("/repo/subproject")
  })
  test("late focus requests cannot steal a newly selected project's session", () => {
    expect(shouldFocusWorkflowSession({ directory: "/repo", focus: true }, "/repo/subproject")).toBe(false)
    expect(shouldFocusWorkflowSession({ directory: "/repo", focus: true }, "/repo")).toBe(true)
    expect(shouldFocusWorkflowSession({ directory: "/repo", focus: true })).toBe(true)
    expect(shouldFocusWorkflowSession({ directory: "/repo", focus: false }, "/repo")).toBe(false)
  })
})
