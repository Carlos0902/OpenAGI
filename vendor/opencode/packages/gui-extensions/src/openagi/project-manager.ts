import type { IpcClient, ProjectManager, ProjectTarget } from "../sdk"
import type { OpenAGI, WorkflowState } from "./contract"

type Client = Pick<IpcClient<typeof OpenAGI.spec>, "project" | "pickProject" | "pause" | "forget">

export function createWorkflowProjectManager(options: {
  state(): WorkflowState | undefined
  client(): Client | undefined
  select(directory: string): void
  start(): Promise<void>
  signal: AbortSignal
}): ProjectManager {
  const client = () => {
    options.signal.throwIfAborted()
    const current = options.client()
    if (!current) throw new Error("The project manager is unavailable")
    return current
  }
  const owner = (target: ProjectTarget) =>
    options.state()?.servers.find((server) => server.id === target.server)?.directory ?? target.directory
  const select = async (target: ProjectTarget) => {
    const opened = await client().project({ directory: owner(target) }, { signal: options.signal })
    options.signal.throwIfAborted()
    options.select(opened.directory)
  }
  return {
    priority: 100,
    get entries() {
      return (options.state()?.servers ?? []).map((server) => ({ server: server.id, directory: server.directory }))
    },
    handles: (input) => input.builtin || !!options.state()?.servers.some((server) => server.id === input.server),
    async choose() {
      const target = await client().pickProject({ signal: options.signal })
      options.signal.throwIfAborted()
      if (!target) return
      options.select(target.directory)
      return target
    },
    async add(directories) {
      const targets: ProjectTarget[] = []
      for (const directory of new Set(directories)) {
        const target = await client().project({ directory }, { signal: options.signal })
        options.signal.throwIfAborted()
        if (!targets.some((item) => item.server === target.server && item.directory === target.directory))
          targets.push(target)
      }
      const latest = targets.at(-1)
      if (latest) options.select(latest.directory)
      return targets
    },
    select,
    async start(target) {
      await select(target)
      await options.start()
    },
    async close(target) {
      const directory = owner(target)
      if (options.state()?.projects.some((project) => project.directory === directory))
        await client().pause({ directory }, { signal: options.signal })
    },
    async remove(target) {
      const directory = owner(target)
      if (options.state()?.projects.some((project) => project.directory === directory))
        await client().forget({ directory }, { signal: options.signal })
    },
  }
}
