import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { createSignal, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useExtension } from "../sdk"
import ConfigurationSettings from "./configuration-settings"
import type definition from "./index"
import type { WorkflowState } from "./contract"

export default { title: "OpenAGI/Configuration", id: "openagi-configuration", component: ConfigurationSettings }
export const NativeEditors = { render: () => <ConfigurationFixture /> }
function ConfigurationFixture() {
  const extension = useExtension<typeof definition>()
  const dialog = useDialog()
  const [page, setPage] = createSignal<"providers" | "models">("providers")
  const [state, setState] = createStore<WorkflowState>({ projects: [], servers: [], sessions: [], configuration: { file: "/fixture/.openagi/config.json", providers: [{ id: "primary", type: "openai-compatible", baseURL: "http://gateway.invalid/v1", contextWindow: 128000, maxOutputTokens: 8192, hasKey: true }], models: { heavy: { providerID: "primary", modelID: "heavy" }, light: { providerID: "primary", modelID: "light" } }, jevConfigured: true } })
  const [events, setEvents] = createSignal<string[]>([])
  const client: NonNullable<ReturnType<ComponentProps<typeof ConfigurationSettings>["client"]>> = {
    state: () => state,
    saveProvider: async input => { setEvents(events => [...events, `provider ${input.id} ${input.baseURL} keyChanged=${!!input.apiKey}`]); setEvents(events => [...events, `manual ${input.id} ${input.models?.map(model => model.id).join(",") ?? ""} headers=${input.headers?.map(header => header.key).join(",") ?? ""}`]); setState("configuration", "providers", providers => {
      const previous = providers.find(provider => provider.id === input.id);
      const next = { id: input.id, type: input.type, baseURL: input.baseURL, contextWindow: input.contextWindow, maxOutputTokens: input.maxOutputTokens, hasKey: !!input.apiKey || previous?.hasKey || false, name: input.name, models: input.models, headerNames: input.headers?.map(header => header.key) };
      return previous ? providers.map(provider => provider.id === input.id ? next : provider) : [...providers, next];
    }) },
    removeProvider: async input => { setEvents(events => [...events, `remove ${input.id}`]) },
    providerModels: async input => { setEvents(events => [...events, `catalog ${input.id}`]); const declared = state.configuration?.providers.find(provider => provider.id === input.id)?.models; return declared?.length ? declared.map(model => ({ ...model, name: model.name ?? model.id })) : [{ id: "heavy", name: "heavy" }, { id: "light", name: "light" }] },
    selectModel: async input => { setEvents(events => [...events, `model ${input.role} ${input.modelID}`]); setState("configuration", "models", input.role, { providerID: input.providerID, modelID: input.modelID }) },
    saveJev: async () => { setEvents(events => [...events, "jev keyChanged"]) },
    pause: async () => {},
  }
  const context: ComponentProps<typeof ConfigurationSettings>["ctx"] = { t: extension.t, dialogs: { open: render => { const handle = { close: () => dialog.close() }; void dialog.show(() => render(handle)); return handle }, active: () => !!dialog.active } }
  return <div class="settings-panel"><Button onClick={() => setPage("providers")}>Provider settings</Button><Button onClick={() => setPage("models")}>Model settings</Button><ConfigurationSettings ctx={context} client={() => client} page={page()} network={() => <p>Global network proxy</p>} report={error => setEvents(events => [...events, String(error)])} /><pre aria-label="Recorded configuration actions">{events().join("\n")}</pre></div>
}
