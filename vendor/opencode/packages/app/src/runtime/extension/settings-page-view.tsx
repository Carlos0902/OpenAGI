import { For, Show, createEffect, on, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Spinner } from "@opencode/ui/spinner"
import { isOpenAGI } from "@/runtime/product"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useExtensionHost } from "./host"
import { useDialog } from "@opencode/ui/context/dialog"
import { Tabs } from "@opencode/ui/tabs"
import { useSettingsSurface } from "@/settings/surface"
import { Contribution } from "./render"

/** One settings panel per extension page; the tab value is the SettingsPage id. */
export function ExtensionSettingsPages() {
  const surface = useSettingsSurface()

  return (
    <For each={surface.extensions.pages()}>
      {(item) => (
        <Tabs.Content value={item.value.id} class="settings-panel">
          <Contribution extension={item.extension}>
            {() =>
              item.value.render({
                get target() {
                  const view = surface.view()

                  return view.tab === item.value.id ? view.target : undefined
                },
              })
            }
          </Contribution>
        </Tabs.Content>
      )}
    </For>
  )
}

/**
 * Extension sections on a host settings page, in contribution order; with `section`, the extension rows placed in
 * that host section, rendered where the host lists them.
 */
export function ExtensionSettingsSections(props: { page: "general" | "servers" | "providers" | "models"; section?: "general" }) {
  const surface = useSettingsSurface()

  return (
    <For each={surface.extensions.sections(props.page, props.section)}>
      {(item) => (
        <Contribution extension={item.extension}>
          {() =>
            item.value.render({
              get target() {
                return surface.view().target
              },
            })
          }
        </Contribution>
      )}
    </For>
  )
}


/** Keeps native settings navigation while a contributed editor owns its configuration source. */
export function ExtensionSettingsReplacement(props: { page: "providers" | "models"; children?: JSX.Element }) {
  const surface = useSettingsSurface()
  return (
    <Show when={surface.extensions.replacement(props.page)} fallback={isOpenAGI ? <ConfigurationUnavailable /> : <>{props.children}<ExtensionSettingsSections page={props.page} /></>}>
      {(item) => <Contribution extension={item().extension}>{() => item().value.render({ get target() { return surface.view().target } })}</Contribution>}
    </Show>
  )
}


/** Routes legacy configuration launchers to an editor that replaces the corresponding native settings page. */
export function ExtensionSettingsRedirect(props: { page: "providers" | "models"; children?: JSX.Element }) {
  const surface = useSettingsSurface()
  const dialog = useDialog()
  createEffect(on(() => isOpenAGI || !!surface.extensions.replacement(props.page), managed => { if (managed) { dialog.close(); surface.open(props.page) } }))
  return <Show when={!isOpenAGI && !surface.extensions.replacement(props.page)}>{props.children}</Show>
}


/** A product configuration load failure never exposes another credential store or the old custom-provider stub. */
function ConfigurationUnavailable() {
  const host = useExtensionHost()
  const language = useLanguage()
  const bridge = usePlatform().extensions
  const reload = () => { host.reload("openagi"); void bridge?.manager.reload("openagi") }
  const loading = () => !host.state.status.openagi || host.state.status.openagi === "loading"
  return <div class="settings-tab-body settings-tab-body--sectioned">
    <Show when={loading()} fallback={<div role="alert" class="flex flex-col gap-3"><p>{language.t("settings.configuration.unavailable")}</p><Button onClick={reload}>{language.t("settings.configuration.reload")}</Button></div>}>
      <div role="status" class="flex items-center gap-2"><Spinner /><span>{language.t("settings.configuration.loading")}</span></div>
    </Show>
  </div>
}
