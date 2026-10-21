import { useProjectManagerActions } from "@/runtime/extension/projects"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { useServerActionsController } from "@/servers/registry/controller"
import { useSettingsCommand } from "@/settings/command"
import { useSettingsSurface } from "@/settings/surface"
import { type LocalProject } from "@/shell/state/layout"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "@/runtime/server/registry"
import { closeHomeProject, errorMessage, homeProjectDirectories } from "@/shell/layout/helpers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { showToast } from "@/shell/notifications/toast"
import { useDialog } from "@opencode/ui/context/dialog"
import { createMemo, createResource } from "solid-js"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import type { HomeController } from "../model"
import { useGlobal } from "@/runtime/server/runtime"
import { SessionTransfer } from "@opencode/schema/session-transfer"
import { useRevealProject } from "./reveal"
import { homeProjectEntries, homeProjectEntryKey, moveHomeProjectOrder } from "./order"

export const HomeServersSchema = Persistence.struct({
  collapsed: Persistence.record(Persistence.fallback(Schema.Boolean, () => false)),
  projectOrder: Persistence.array(Schema.String),
})

export function createHomeProjectsController(home: HomeController) {
  const actions = useProjectManagerActions()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const language = useLanguage()
  const openSettings = useSettingsCommand()
  const settings = useSettingsSurface()
  const serverManagement = useServerActionsController()
  const global = useGlobal()
  const revealProject = useRevealProject()
  const [_state, setState, _, ready] = persisted(Persist.global("home.servers"), HomeServersSchema, {
    collapsed: {},
    projectOrder: [],
  })

  const [state] = createResource(
    () => ready.promise ?? Promise.resolve(),
    (promise) => promise.then(() => _state),
    { initialValue: _state },
  )
  const flatProjects = createMemo(() =>
    homeProjectEntries({
      servers: home.server.list(),
      projects: home.project.forServer,
      order: state().projectOrder,
    }),
  )

  function edit(conn: ServerConnection.Http, onSave?: (saved: ServerConnection.Http) => void) {
    void import("@/servers/connect/dialog").then(({ DialogServer }) => {
      void dialog.show(() => <DialogServer mode="edit" server={conn} onSave={(saved) => onSave?.(saved)} />)
    })
  }

  // An expired pairing session or a changed password signs the app out of an HTTP server; signing in again edits it,
  // and the action that asked for sign-in continues once the dialog saves, as it does for extension servers. It continues
  // with the saved connection: the one it started with still carries the rejected credentials.
  function authenticate(conn: ServerConnection.Any, onConnected?: (conn: ServerConnection.Any) => void) {
    if (conn.type !== "http" || !home.server.health(conn)?.unauthorized)
      return ServerConnection.authenticate(conn, () => onConnected?.(conn))
    edit(conn, onConnected)

    return true
  }

  function directories(project: LocalProject) {
    return [project.worktree, ...(project.sandboxes ?? [])]
  }

  function choose(conn: ServerConnection.Any) {
    if (actions.handles(conn)) {
      void actions
        .choose(conn)
        .then((target) => {
          if (target) home.selection.set({ server: ServerConnection.key(target.server), directory: target.directory })
        })
        .catch((cause) =>
          showToast({
            variant: "error",
            title: language.t("common.requestFailed"),
            description: errorMessage(cause, language.t("common.requestFailed")),
          }),
        )
      return
    }
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => home.project.add(conn, homeProjectDirectories(result)),
    })
  }

  return {
    copy: {
      language,
    },
    selection: {
      value: home.selection.value,
    },
    server: {
      list: home.server.list,
      projectMode: home.server.projectMode,
      health: home.server.health,
      projects: home.project.forServer,
      recentlyClosed: (conn: ServerConnection.Any) => home.server.context(conn).projects.recentlyClosed(),
      collapsed: (conn: ServerConnection.Any) => state().collapsed[ServerConnection.key(conn)] ?? false,
      toggleCollapsed: (conn: ServerConnection.Any) => {
        const key = ServerConnection.key(conn)
        setState("collapsed", key, !state().collapsed[key])
      },
      canRemove: (conn: ServerConnection.Any) => serverManagement.connection.canRemove(ServerConnection.key(conn)),
      remove: (conn: ServerConnection.Any) => serverManagement.connection.remove(ServerConnection.key(conn)),
      canHide: (conn: ServerConnection.Any) => serverManagement.connection.canHide(ServerConnection.key(conn)),
      hide: (conn: ServerConnection.Any) => serverManagement.connection.setHidden(ServerConnection.key(conn), true),
      edit: (conn: ServerConnection.Http) => edit(conn),
      authenticate: (conn: ServerConnection.Any) => authenticate(conn),
      focus: (conn: ServerConnection.Any) => {
        if (authenticate(conn, (next) => home.selection.focusServer(next))) return
        home.selection.focusServer(conn)
      },
    },
    project: {
      list: home.project.list,
      flat: flatProjects,
      recentlyClosed: home.project.recentlyClosed,
      homedir: home.project.homedir,
      select: (conn: ServerConnection.Any, directory: string) => {
        if (authenticate(conn, (next) => home.project.select(next, directory))) return
        home.project.select(conn, directory)
      },
      add: (conn: ServerConnection.Any, directories: string[]) => {
        if (!actions.handles(conn)) return home.project.add(conn, directories)
        void actions.add(conn, directories).then((targets) => {
          const target = targets[0]
          if (target) home.selection.set({ server: ServerConnection.key(target.server), directory: target.directory })
        })
      },
      openNewSession: (conn: ServerConnection.Any, directory: string) => {
        if (authenticate(conn, (next) => home.project.openProjectNewSession(next, directory))) return
        home.project.openProjectNewSession(conn, directory)
      },
      canImportSession: !!platform.openAttachmentPickerDialog,
      importSession: (conn: ServerConnection.Any, project: LocalProject) => {
        if (!platform.openAttachmentPickerDialog) return
        void platform
          .openAttachmentPickerDialog(
            {
              title: language.t("command.session.import"),
              accept: ["application/json"],
              extensions: ["json"],
            },
            async (file) => {
              const data = await Schema.decodeUnknownPromise(Schema.fromJsonString(SessionTransfer.Data))(
                await file.text(),
              )

              const api = home.server.context(conn).sdk.api.session

              // SAFETY: the payload is SessionTransfer.Data's own encoding, which the import endpoint decodes and validates.
              const imported = await api.import({
                ...Schema.encodeSync(SessionTransfer.Data)(data),
                location: { directory: project.worktree },
              } as Parameters<typeof api.import>[0])

              home.project.openProjectSession(conn, project.worktree, imported)
            },
          )
          .catch((cause: unknown) => {
            showToast({
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            })
          })
      },
      edit: (conn: ServerConnection.Any, project: LocalProject) => {
        settings.openProject({
          server: ServerConnection.key(conn),
          project: project.worktree,
        })
      },
      unseenCount: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = global.ensureServerCtx(conn).notification

        return directories(project).reduce((total, directory) => total + notification.project.unseenCount(directory), 0)
      },
      clearNotifications: (conn: ServerConnection.Any, project: LocalProject) => {
        const notification = global.ensureServerCtx(conn).notification
        directories(project)
          .filter((directory) => notification.project.unseenCount(directory) > 0)
          .forEach((directory) => notification.project.markViewed(directory))
      },
      choose: (conn: ServerConnection.Any) => {
        if (authenticate(conn, (next) => choose(next))) return

        if (!actions.handles(conn) && home.server.health(conn)?.healthy === false) return
        choose(conn)
      },
      remove: (conn: ServerConnection.Any, directory: string) => {
        void actions
          .remove(conn, directory)
          .catch((cause) =>
            showToast({
              variant: "error",
              title: language.t("common.requestFailed"),
              description: errorMessage(cause, language.t("common.requestFailed")),
            }),
          )
      },
      close: (conn: ServerConnection.Any, directory: string) => {
        if (actions.handles(conn)) void actions.close(conn, directory)
        const next = closeHomeProject(
          home.selection.value(),
          ServerConnection.key(conn),
          home.server.context(conn).projects,
          directory,
        )

        if (next) home.selection.set(next)
      },
      move: (conn: ServerConnection.Any, worktree: string, index: number) => {
        if (home.server.projectMode() && ServerConnection.project(conn)) {
          setState(
            "projectOrder",
            moveHomeProjectOrder(
              flatProjects(),
              homeProjectEntryKey({ server: conn, project: { worktree, expanded: true } }),
              index,
            ),
          )
          return
        }
        home.server.context(conn).projects.move(worktree, index)
      },
      canReveal: revealProject.available,
      reveal: revealProject.reveal,
    },
    utility: {
      settings: openSettings,
      help: () => settings.open("about"),
    },
  }
}

export type HomeProjectsController = ReturnType<typeof createHomeProjectsController>
