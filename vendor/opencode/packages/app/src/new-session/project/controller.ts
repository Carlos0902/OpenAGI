import { createMemo } from "solid-js"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useGlobal } from "@/runtime/server/runtime"
import { useServerSDK } from "@/runtime/server/client"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useWorkspaceLocation } from "@/workspaces/location"
import { workspaceSelectionDestination } from "@/workspaces/paths"
import { useTabs } from "@/shell/tabs/tabs"
import type { PromptProjectControls } from "./selector"
import { composerProjectInventory } from "./inventory"
import { useProjectManagerActions } from "@/runtime/extension/projects"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"

export function createComposerProjectControls(props: { draftId: string; worktree: () => string }) {
  const servers = useServers()
  const serverSDK = useServerSDK()
  const location = useWorkspaceLocation()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const projectServer = () => serverSDK.server
  const actions = useProjectManagerActions()
  const language = useLanguage()
  const report = (error: Error) => showToast({ variant: "error", title: language.t("common.requestFailed"), description: error.message })
  const projects = createMemo(() => composerProjectInventory(servers.list, global.ensureServerCtx, actions.active()))

  const selectProject = (worktree: string, serverKey?: string) => {
    const connection = serverKey
      ? servers.list.find((connection) => ServerConnection.key(connection) === serverKey)
      : projectServer()

    if (!connection) return

    if (actions.handles(connection)) void actions.select(connection, worktree).catch(report)

    const target = global.ensureServerCtx(connection)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    tabs.updateDraft(props.draftId, {
      server: ServerConnection.key(connection),
      directory: worktree,
      worktree: workspaceSelectionDestination(props.worktree(), location().directory),
      branch: undefined,
    })
  }

  const addProject = (title: string, serverKey?: string) => {
    const connection = serverKey
      ? servers.list.find((connection) => ServerConnection.key(connection) === serverKey)
      : projectServer()

    if (!connection) return

    if (actions.handles(connection)) {
      void actions.choose(connection).then((target) => {
        if (target) selectProject(target.directory, ServerConnection.key(target.server))
      }).catch(report)

      return
    }

    pickDirectory({
      server: connection,
      location: ServerConnection.key(connection) === ServerConnection.key(projectServer()) ? location().ref : undefined,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result

        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: location().directory,
    projectID: location().current?.project.id,
    server: ServerConnection.key(projectServer()),
    select: selectProject,
    add: addProject,
  }))
}
