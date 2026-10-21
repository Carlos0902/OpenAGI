import { createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { OpenAGI, type WorkflowState } from "@opencode/gui-extensions/openagi/contract"
import { useData, useServer } from "@/runtime/server/current"
import { useExtensionHost } from "./host"
import { workflowSessionMetadata } from "./openagi-session"

export { workflowSessionMetadata } from "./openagi-session"

/** Read the same schema-decoded client used by the native OpenAGI extension. */
export function useOpenAGIClient() {
  const host = useExtensionHost()
  const client = () => host.ipc(OpenAGI)
  return { client, state: () => client()?.state() }
}

export function workflowProject(state: WorkflowState | undefined, server: string, id: string | undefined) {
  if (!state || !id) return
  const directory = state.servers.find((item) => item.id === server)?.directory
  return state.projects.find((item) => item.directory === directory && item.mainSessionId === id)
}

/** Membership belongs to a project, while each native session retains its own context and location. */
export function useOpenAGIWorkflow() {
  const shared = useOpenAGIClient()
  const params = useParams()
  const server = useServer()
  const data = useData()
  const project = createMemo(() => workflowProject(shared.state(), server.key, params.id))
  const active = createMemo(
    () =>
      !!project() || workflowSessionMetadata(params.id ? data.session.get(params.id) : undefined)?.kind === "workflow",
  )
  const sessions = createMemo(() => {
    const current = project()
    if (!current) return []
    return (
      shared
        .state()
        ?.sessions.filter(
          (item) =>
            item.serverId === server.key &&
            item.directory === current.directory &&
            item.mode !== "workflow" &&
            item.mainSessionId === current.mainSessionId,
        ) ?? []
    )
  })
  const memberIDs = createMemo(
    () => {
      if (!active() || !params.id) return []
      const persisted = data.session
        .list()
        .filter((item) => workflowSessionMetadata(item)?.mainSessionId === params.id)
        .map((item) => item.id)
      return [
        params.id,
        ...[...new Set([...sessions().map((item) => item.sessionId), ...persisted])]
          .filter((id) => id !== params.id)
          .sort(),
      ]
    },
    [],
    { equals: (before, after) => before.length === after.length && before.every((id, index) => id === after[index]) },
  )
  return { ...shared, project, active, sessions, memberIDs }
}
