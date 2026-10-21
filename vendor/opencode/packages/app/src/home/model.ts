import { isOpenAGI } from "@/runtime/product"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { type HomeProjectSelection, useLayout } from "@/shell/state/layout"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { toggleHomeProjectSelection } from "@/shell/layout/helpers"
import { createEffect, createMemo, startTransition } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { pathKey } from "@/workspaces/path-key"
import { useProjectManagerActions } from "@/runtime/extension/projects"
import { addProjects } from "./projects/add"
import { workflowSessionMetadata } from "@/runtime/extension/openagi-session"

export function createHomeController() {
  const layout = useLayout()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const actions = useProjectManagerActions()
  const selection = layout.home.selection
  const visible = createMemo(() =>
    isOpenAGI
      ? servers.visible.filter((conn) => ServerConnection.project(conn) || ServerConnection.builtin(conn))
      : servers.visible,
  )

  const focusedServer = createMemo<ServerConnection.Any | undefined>(
    () => visible().find((conn) => ServerConnection.key(conn) === selection().server) ?? visible()[0],
  )

  const focusedServerCtx = useServerCtx(focusedServer)
  const focusedSync = () => focusedServerCtx()?.sync
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? [])
  const recentlyClosed = createMemo(() => focusedServerCtx()?.projects.recentlyClosed() ?? [])
  const homedir = createMemo(() => focusedSync()?.data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))

  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    const list = visible()

    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list[0]

    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })
  createEffect(() => {
    const ctx = focusedServerCtx()
    const id = selectedProject()?.id

    if (!ctx || !id || ctx.sdk.connection.status() !== "connected") return
    // Selecting a project is the demand for its worktree inventory: the session filter spans its worktrees.
    void ctx.sync.worktrees.list(id).then(() => ctx.sync.worktrees.refresh(id))
  })
  createEffect(() => {
    // The project list is empty until the server store hydrates; clearing the restored
    // selection against it would persist the loss.
    if (!servers.hydrated()) return
    const current = selection()
    const directory = current.directory

    if (!directory) return
    const conn = visible().find((conn) => ServerConnection.key(conn) === current.server)

    if (!conn) return

    if (
      global
        .ensureServerCtx(conn)
        .projects.list()
        .some((project) => pathKey(project.worktree) === pathKey(directory))
    )
      return
    setSelection({ server: current.server })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    if (actions.handles(conn)) {
      void actions.start(conn, directory)
      return
    }
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  function openProjectSession(conn: ServerConnection.Any, directory: string, session: SessionInfo) {
    const ctx = global.ensureServerCtx(conn)
    const metadata = workflowSessionMetadata(session)
    if (metadata?.kind === "module" && metadata.mainSessionId) {
      const mainSessionId = metadata.mainSessionId
      void (
        ctx.data.session.get(mainSessionId)
          ? Promise.resolve(ctx.data.session.get(mainSessionId)!)
          : ctx.sdk.api.session.get({ sessionID: mainSessionId })
      )
        .then((main) => openProjectSession(conn, metadata.directory, main))
        .catch(() => undefined)
      return
    }
    void ctx.data.session.message.sync(session.id).catch(() => undefined)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
      ctx.data.session.remember(session)
      ctx.projects.open(directory)
      ctx.projects.touch(directory)
    })
  }

  return {
    selection: {
      value: selection,
      set: setSelection,
      focusServer: (conn: ServerConnection.Any) => setSelection({ server: ServerConnection.key(conn) }),
    },
    server: {
      list: () => visible(),
      projectMode: () => isOpenAGI || actions.active(),
      health: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
      context: (conn: ServerConnection.Any) => global.ensureServerCtx(conn),
      focused: focusedServer,
      focusedContext: focusedServerCtx,
      focusedSync,
    },
    project: {
      list: projects,
      recentlyClosed,
      homedir,
      selected: selectedProject,
      newSession: newSessionProject,
      forServer: (conn: ServerConnection.Any) => global.ensureServerCtx(conn).projects.list(),
      select: (conn: ServerConnection.Any, directory: string) => {
        const key = ServerConnection.key(conn)

        if (!ServerConnection.project(conn) && global.servers.health[key]?.healthy === false) return

        if (
          !global
            .ensureServerCtx(conn)
            .projects.list()
            .some((project) => project.worktree === directory)
        )
          return
        setSelection(toggleHomeProjectSelection(selection(), key, directory))
        if (actions.handles(conn)) void actions.select(conn, directory)
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        const directory = addProjects(global.ensureServerCtx(conn), directories)

        if (!directory) return
        setSelection({ server: ServerConnection.key(conn), directory })
      },
      openNewSession: () => {
        const conn = focusedServer()
        const project = newSessionProject()

        if (!conn || !project) return
        openProjectNewSession(conn, project.worktree)
      },
      openProjectNewSession,
      openProjectSession,
    },
  }
}

export type HomeController = ReturnType<typeof createHomeController>
