import { Schema } from "effect"
import type { WorkflowState } from "./contract"

const RememberedSession = Schema.Struct({
  serverId: Schema.String,
  directory: Schema.String,
  sessionId: Schema.String,
  mode: Schema.String,
  purpose: Schema.optional(Schema.String),
  label: Schema.String,
  outcome: Schema.optional(Schema.Literals(["running", "succeeded", "failed", "interrupted"])),
})

/** Desktop-owned metadata only. Model credentials and transcript remain in their existing project stores. */
export const WorkspacePreferences = Schema.Struct({
  directories: Schema.Array(Schema.String),
  selectedProject: Schema.optional(Schema.String),
  sessions: Schema.Array(RememberedSession),
})
export type WorkspacePreferences = typeof WorkspacePreferences.Type

type RestoreBridge = {
  state(): WorkflowState
  project(directory: string, input?: { select?: boolean }): Promise<void>
  rememberSessions(sessions: readonly (typeof RememberedSession.Type)[]): void | Promise<void>
}

export function rememberWorkspace(state: WorkflowState): WorkspacePreferences {
  const directories = [...new Set(state.projects.map((project) => project.directory))]
  const known = new Set(directories)
  return {
    directories,
    selectedProject: state.selectedProject && known.has(state.selectedProject) ? state.selectedProject : undefined,
    sessions: state.sessions
      .filter((session) => known.has(session.directory))
      .map(({ serverId, directory, sessionId, mode, purpose, label, outcome }) => ({
        serverId,
        directory,
        sessionId,
        mode,
        purpose,
        label,
        outcome,
      })),
  }
}

/** Restore native connectivity and ownership, never an OpenAGI operation or an agent turn. */
export async function restoreWorkspace(bridge: RestoreBridge, saved: WorkspacePreferences, signal: AbortSignal) {
  const explicitProject = bridge.state().selectedProject
  for (const directory of new Set(saved.directories)) {
    signal.throwIfAborted()
    try {
      await bridge.project(directory, { select: false })
    } catch {
      signal.throwIfAborted() /* A missing or inaccessible folder is omitted from the next saved inventory. */
    }
  }
  signal.throwIfAborted()
  const known = new Set(bridge.state().projects.map((project) => project.directory))
  await bridge.rememberSessions(saved.sessions.filter((session) => known.has(session.directory)))
  signal.throwIfAborted()
  // Calls made while the restore awaited a backend also count as explicit selection.
  const selected = bridge.state().selectedProject ?? explicitProject ?? saved.selectedProject
  if (selected && known.has(selected) && bridge.state().selectedProject !== selected) await bridge.project(selected)
  signal.throwIfAborted()
  return rememberWorkspace(bridge.state())
}
