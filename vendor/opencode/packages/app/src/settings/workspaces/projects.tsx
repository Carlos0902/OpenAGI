import { Show, createEffect, createMemo, type Component } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"
import { displayName } from "@opencode/ui/project-avatar"
import { homeProjectDirectories } from "@/shell/layout/helpers"
import type { LocalProject } from "@/shell/state/layout"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { addProjects } from "@/home/projects/add"
import { settingsProjectInventory } from "../servers/inventory"
import { useProjectManagerActions } from "@/runtime/extension/projects"
import { SettingsSearchEmpty } from "../search-empty"
import { SettingsSearchField } from "../search-field"
import { SettingsProjectRow } from "./project-row"
import "@/settings/search.css"
import "@/settings/settings.css"

export const SettingsProjects: Component<{
  server?: ServerConnection.Any
  servers?: readonly ServerConnection.Any[]
  active: boolean
  onOpenProject: (project: LocalProject, server: ServerConnection.Any) => void
}> = (props) => {
  const language = useLanguage()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [store, setStore] = createStore({ filter: "" })
  const actions = useProjectManagerActions()
  const connections = () => props.servers ?? (props.server ? [props.server] : [])
  const projects = createMemo(() => settingsProjectInventory(connections(), global.ensureServerCtx))
  const managed = () => props.servers !== undefined && (actions.active() || connections().some(ServerConnection.project))
  const searchable = createMemo(() => projects().length > 7)

  const filtered = createMemo(() => {
    const query = searchable() ? store.filter.trim().toLowerCase() : ""

    return query ? projects().filter((project) => displayName(project.project).toLowerCase().includes(query)) : projects()
  })

  createEffect(() => {
    if (!searchable()) setStore("filter", "")
  })

  const openAdded = (server: ServerConnection.Any, directory: string) => {
    const project = global.ensureServerCtx(server).projects.list().find((item) => item.worktree === directory)

    if (project) props.onOpenProject(project, server)
  }

  const addProject = () => {
    const server = props.server ?? connections()[0]

    if (!server) return

    if (actions.handles(server)) {
      void actions.choose(server).then((target) => {
        if (target) openAdded(target.server, target.directory)
      })

      return
    }

    pickDirectory({
      server,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => {
        const directories = homeProjectDirectories(result)
        const directory = addProjects(global.ensureServerCtx(server), directories)

        if (directory && directories.length === 1) openAdded(server, directory)
      },
    })
  }

  return (
    <>
      <div class="settings-tab-header" classList={{ "settings-tab-header--stacked": searchable() }}>
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.projects.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t(managed() ? "settings.projects.description.managed" : "settings.projects.description")}</span>
          </div>
          <Show when={projects().length > 0}>
            <Button variant="ghost-muted" icon="plus" onClick={addProject}>
              {language.t("home.project.add")}
            </Button>
          </Show>
        </div>
        <Show when={searchable()}>
          <SettingsSearchField
            value={store.filter}
            active={props.active}
            onInput={(value) => setStore("filter", value)}
            placeholder={language.t("settings.projects.search.placeholder")}
          />
        </Show>
      </div>

      <div class="settings-tab-body">
        <Show
          when={filtered().length > 0}
          fallback={
            <Show
              when={!store.filter.trim() && projects().length === 0}
              fallback={
                <Show
                  when={store.filter.trim()}
                  fallback={
                    <div class="py-12 text-center text-v2-text-text-muted text-13-regular">
                      {language.t("settings.projects.empty")}
                    </div>
                  }
                >
                  <div class="settings-tab-search-empty">
                    <SettingsSearchEmpty query={store.filter} />
                  </div>
                </Show>
              }
            >
              <div
                data-component="settings-project-empty-card"
                class="settings-project-empty-card flex flex-col items-center gap-2 py-24 text-center"
              >
                <Icon name="folder" size="large" class="mb-2 text-v2-icon-icon-muted" />
                <div class="text-13-medium text-v2-text-text-base">
                  {language.t("settings.projects.empty.title")}
                </div>
                <div class="text-13-regular text-v2-text-text-muted">
                  {language.t("settings.projects.empty.description")}
                </div>
                <Button variant="neutral" icon="plus" class="mt-6" onClick={addProject}>
                  {language.t("home.project.add")}
                </Button>
              </div>
            </Show>
          }
        >
          <div role="list" class="settings-project-list">
            <Key each={filtered()} by="key">
              {(target) => (
                <SettingsProjectRow
                  project={target().project}
                  server={target().server}
                  onOpen={(project) => props.onOpenProject(project, target().server)}
                />
              )}
            </Key>
          </div>
        </Show>
      </div>
    </>
  )
}
