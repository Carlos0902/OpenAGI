import type { WorkflowProject, WorkflowState } from "./contract"

type NativeSessionOwner = { id: string; directory: string; server: { id: string }; project?: { worktree: string } }

/** A live orchestration loop may be waiting for recovery while its model session is already idle. */
export function workflowStatus(project: WorkflowProject | undefined) {
  if (project?.phase === "stopping") return "stopping"
  if (project?.error) return "recovery"
  if (project?.prompt) return "pending"
  if (!project || project.phase === "idle") return "idle"
  if (project.phase === "configuring") return "configuring"
  return project.activity ? `stage.${project.activity}` as const : "running"
}

/** A worktree's canonical Git project may be another opened OpenAGI project. Prefer explicit ownership. */
export function workflowProjectForSession(state: WorkflowState | undefined, session: NativeSessionOwner) {
  if (!state) return
  const owner =
    state.sessions.find((item) => item.sessionId === session.id && item.serverId === session.server.id)?.directory ??
    state.servers.find((item) => item.id === session.server.id)?.directory
  if (owner) return state.projects.find((item) => item.directory === owner)
  if (session.server.id.startsWith("openagi:")) return
  return (
    state.projects.find((item) => item.directory === session.directory) ??
    state.projects.find((item) => item.directory === session.project?.worktree)
  )
}

/** Late background work cannot take focus away from a newly chosen project. */
export function shouldFocusWorkflowSession(session: { directory: string; focus?: boolean }, selected?: string) {
  return !!session.focus && (!selected || selected === session.directory)
}

/** Each OpenAGI server owns one folder; its native project can display the Git parent's canonical directory. */
export function closedWorkflowProject(detail: unknown, servers: WorkflowState["servers"]): string | undefined {
  if (!detail || typeof detail !== "object") return
  const value = detail as { server?: unknown; directory?: unknown }
  if (typeof value.server !== "string" || typeof value.directory !== "string") return
  return servers.find((server) => server.id === value.server)?.directory
}
