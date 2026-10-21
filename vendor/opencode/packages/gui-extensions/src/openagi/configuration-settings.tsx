import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { IconButton } from "@opencode/ui/icon-button"
import { Switch } from "@opencode/ui/switch"
import { Icon } from "@opencode/ui/icon"
import { Select } from "@opencode/ui/select"
import { TextField } from "@opencode/ui/text-field"
import { For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import type { IpcClient, SetupContext } from "../sdk"
import { OpenAGI } from "./contract"
import type definition from "./index"

type Client = Pick<IpcClient<typeof OpenAGI.spec>, "state" | "saveProvider" | "removeProvider" | "providerModels" | "selectModel" | "saveJev" | "pause">
type Context = SetupContext<typeof definition>
type Provider = NonNullable<ReturnType<Client["state"]>>["configuration"] extends infer View ? View extends { providers: readonly (infer Row)[] } ? Row : never : never

type Props = { ctx: Pick<Context, "t" | "dialogs">; client: Accessor<Client | undefined>; page: "providers" | "models"; network: () => JSX.Element; report: (error: unknown) => void }
function Row(props: { id?: string; title: string; description: string; children?: JSX.Element }) {
  return <div data-action={props.id} data-component="settings-row"><div data-slot="settings-row-copy"><div data-slot="settings-row-title">{props.title}</div><div data-slot="settings-row-description">{props.description}</div></div><div data-slot="settings-row-control">{props.children}</div></div>
}
export default function ConfigurationSettings(props: Props) {
  const view = () => props.client()?.state()?.configuration
  const busy = () => props.client()?.state()?.projects.some(project => project.phase !== "idle") ?? false
  const editProvider = (provider?: Provider) => props.ctx.dialogs.open(dialog => <ProviderDialog {...props} provider={provider} onDone={dialog.close} />)
  const editModel = (role: "heavy" | "light") => props.ctx.dialogs.open(dialog => <ModelDialog {...props} role={role} onDone={dialog.close} />)
  const editJev = () => props.ctx.dialogs.open(dialog => <JevDialog {...props} onDone={dialog.close} />)
  const remove = (id: string) => void props.client()?.removeProvider({ id }).catch(props.report)
  const roleText = (role: "heavy" | "light") => { const model = view()?.models[role]; return !model || model.modelID.includes("YOUR_") ? props.ctx.t("modelChoose") : `${model.providerID} / ${model.modelID}` }
  return <>
    <div class="settings-tab-header"><div class="settings-tab-header-row"><div class="flex flex-col gap-1"><h2 class="settings-tab-title">{props.ctx.t(props.page === "providers" ? "providersTitle" : "modelsTitle")}</h2><span class="text-11-regular text-v2-text-text-muted">{props.ctx.t("globalConfig")}</span></div><Show when={props.page === "providers"}><Button disabled={busy() || !props.client()} onClick={() => editProvider()}>{props.ctx.t("providerAdd")}</Button></Show></div></div>
    <div class="settings-tab-body settings-tab-body--sectioned">
      <Show when={busy()}><p class="text-12-regular text-v2-text-text-muted">{props.ctx.t("pauseToConfigure")}</p><Button onClick={() => void Promise.all((props.client()?.state()?.projects ?? []).filter(project => project.phase !== "idle").map(project => props.client()!.pause({ directory: project.directory }))).catch(props.report)}>{props.ctx.t("pause")}</Button></Show>
      <section class="settings-section"><div data-component="settings-list">
        <Show when={props.page === "providers"} fallback={<>
          <For each={["heavy", "light"] as const}>{role => <Row id={`openagi-${role}`} title={props.ctx.t(role)} description={roleText(role)}><Button disabled={busy() || !view()?.providers.length} onClick={() => editModel(role)}>{props.ctx.t("modelChoose")}</Button></Row>}</For>
          <Row id="openagi-jev" title="Jev" description={props.ctx.t("jev")}><Icon name="lock" size="small" /></Row>
        </>}>
          <For each={view()?.providers}>{provider => <Row id={`provider-${provider.id}`} title={provider.name ?? provider.id} description={`${provider.type} · ${provider.baseURL}`}><Button disabled={busy()} onClick={() => editProvider(provider)}>{props.ctx.t("providerEdit")}</Button><Button variant="ghost" disabled={busy()} onClick={() => remove(provider.id)}>{props.ctx.t("providerRemove")}</Button></Row>}</For>
          <Row id="provider-typesafe" title="TypeSafe" description={`${props.ctx.t("jev")} · ${props.ctx.t(view()?.jevConfigured ? "keyConfigured" : "keyMissing")}`}><Button disabled={busy() || !props.client()} onClick={editJev}>{props.ctx.t("keyEdit")}</Button></Row>
        </Show>
      </div></section>
      <Show when={props.page === "providers"}>{props.network()}</Show>
    </div>
  </>
}

function ProviderDialog(props: Props & { provider?: Provider; onDone: () => void }) {
  const providerIDs = () => props.client()?.state()?.configuration?.providers.map(provider => provider.id) ?? []
  const nextID = Array.from({ length: providerIDs().length + 1 }, (_, index) => index ? `provider-${index + 1}` : "primary").find(id => !providerIDs().includes(id))!
  const [form, setForm] = createStore({ id: props.provider?.id ?? nextID, type: props.provider?.type ?? "openai-compatible", baseURL: props.provider?.baseURL ?? "", name: props.provider?.name ?? "", apiKey: "", manual: !!props.provider?.models?.length, models: (props.provider?.models ?? []).map(model => ({ ...model, name: model.name ?? model.id })), headers: (props.provider?.headerNames ?? []).map(key => ({ key, value: "" })), contextWindow: props.provider?.contextWindow ?? 128000, maxOutputTokens: props.provider?.maxOutputTokens ?? 8192, busy: false })
  onCleanup(() => { setForm("apiKey", ""); setForm("headers", headers => headers.map(header => ({ ...header, value: "" }))) })
  const save = async () => {
    const client = props.client(); if (!client) return
    if (!props.provider && providerIDs().includes(form.id.trim())) { props.report(new Error(props.ctx.t("providerExists"))); return }
    if (form.manual && !form.models.length) { props.report(new Error(props.ctx.t("manualModelRequired"))); return }
    setForm("busy", true)
    try { await client.saveProvider({ id: form.id.trim(), type: form.type, baseURL: form.baseURL.trim(), ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}), contextWindow: form.contextWindow, maxOutputTokens: form.maxOutputTokens, name: form.name.trim() || undefined, models: form.manual ? form.models.map(model => ({ ...model, id: model.id.trim(), name: model.name.trim() || model.id.trim() })) : [], headers: form.headers.filter(header => header.key.trim()).map(header => ({ key: header.key.trim(), value: header.value })) }); setForm("apiKey", ""); props.onDone() }
    catch (error) { props.report(error) } finally { setForm("busy", false) }
  }
  return <Dialog fit containerClass="max-w-[520px]"><DialogHeader><DialogTitleGroup title={props.ctx.t(props.provider ? "providerEdit" : "providerAdd")} /></DialogHeader><DialogBody class="flex max-h-[75dvh] flex-col gap-4 overflow-y-auto px-4 pb-4">
    <TextField label={props.ctx.t("providerID")} value={form.id} disabled={!!props.provider || form.busy} onInput={event => setForm("id", event.currentTarget.value)} />
    <TextField label={props.ctx.t("providerName")} value={form.name} disabled={form.busy} onInput={event => setForm("name", event.currentTarget.value)} />
    <Select aria-label={props.ctx.t("providerProtocol")} options={["openai-compatible", "openai", "anthropic", "google"] as const} current={form.type} disabled={form.busy} onSelect={type => { if (type) setForm("type", type) }} />
    <TextField label={props.ctx.t("providerURL")} placeholder="https://api.example.com/v1" value={form.baseURL} disabled={form.busy} onInput={event => setForm("baseURL", event.currentTarget.value)} />
    <TextField label={props.ctx.t("keyEdit")} type="password" autocomplete="off" placeholder={props.ctx.t(props.provider?.hasKey ? "keyKeep" : "keyMissing")} value={form.apiKey} disabled={form.busy} onInput={event => setForm("apiKey", event.currentTarget.value)} />
    <TextField label={props.ctx.t("contextWindow")} type="number" value={String(form.contextWindow)} disabled={form.busy} onInput={event => setForm("contextWindow", Number(event.currentTarget.value))} />
    <TextField label={props.ctx.t("maxOutput")} type="number" value={String(form.maxOutputTokens)} disabled={form.busy} onInput={event => setForm("maxOutputTokens", Number(event.currentTarget.value))} />
    <Switch checked={form.manual} disabled={form.busy} onChange={manual => setForm("manual", manual)}>{props.ctx.t("manualModels")}</Switch>
    <Show when={form.manual}>
      <p class="text-12-regular text-v2-text-text-muted">{props.ctx.t("manualModelsDescription")}</p>
      <For each={form.models}>{(model, index) => <div class="flex items-end gap-2">
        <TextField label={props.ctx.t("manualModelID")} value={model.id} disabled={form.busy} onInput={event => setForm("models", index(), "id", event.currentTarget.value)} />
        <TextField label={props.ctx.t("manualModelName")} value={model.name} disabled={form.busy} onInput={event => setForm("models", index(), "name", event.currentTarget.value)} />
        <IconButton icon="trash" aria-label={props.ctx.t("modelRemove")} disabled={form.busy} onClick={() => setForm("models", rows => rows.filter((_, row) => row !== index()))} />
      </div>}</For>
      <Button variant="ghost" disabled={form.busy} onClick={() => setForm("models", rows => [...rows, { id: "", name: "" }])}>{props.ctx.t("modelAdd")}</Button>
    </Show>
    <h3 class="text-13-medium">{props.ctx.t("customHeaders")}</h3>
    <For each={form.headers}>{(header, index) => <div class="flex items-end gap-2">
      <TextField label={props.ctx.t("headerName")} value={header.key} disabled={form.busy} onInput={event => setForm("headers", index(), "key", event.currentTarget.value)} />
      <TextField label={props.ctx.t("headerValue")} type="password" autocomplete="off" placeholder={props.ctx.t("keyKeep")} value={header.value} disabled={form.busy} onInput={event => setForm("headers", index(), "value", event.currentTarget.value)} />
      <IconButton icon="trash" aria-label={props.ctx.t("headerRemove")} disabled={form.busy} onClick={() => setForm("headers", rows => rows.filter((_, row) => row !== index()))} />
    </div>}</For>
    <Button variant="ghost" disabled={form.busy} onClick={() => setForm("headers", rows => [...rows, { key: "", value: "" }])}>{props.ctx.t("headerAdd")}</Button>
    <Button disabled={form.busy} onClick={() => void save()}>{props.ctx.t("configurationSave")}</Button>
  </DialogBody></Dialog>
}
function JevDialog(props: Props & { onDone: () => void }) {
  const [form, setForm] = createStore({ key: "", busy: false })
  onCleanup(() => setForm("key", ""))
  const save = async () => { const client = props.client(); if (!client) return; setForm("busy", true); try { await client.saveJev({ apiKey: form.key }); setForm("key", ""); props.onDone() } catch (error) { props.report(error) } finally { setForm("busy", false) } }
  return <Dialog fit containerClass="max-w-[520px]"><DialogHeader><DialogTitleGroup title="TypeSafe" description={props.ctx.t("jev")} /></DialogHeader><DialogBody class="flex flex-col gap-4 px-4 pb-4"><TextField label={props.ctx.t("keyEdit")} type="password" autocomplete="off" value={form.key} disabled={form.busy} onInput={event => setForm("key", event.currentTarget.value)} /><Button disabled={form.busy || !form.key.trim()} onClick={() => void save()}>{props.ctx.t("configurationSave")}</Button></DialogBody></Dialog>
}
function ModelDialog(props: Props & { role: "heavy" | "light"; onDone: () => void }) {
  const providers = () => props.client()?.state()?.configuration?.providers ?? []
  const selected = props.client()?.state()?.configuration?.models[props.role]
  const [form, setForm] = createStore({ provider: selected?.providerID ?? providers()[0]?.id ?? "", model: selected?.modelID ?? "", models: [] as { id: string; name: string }[], loading: false, busy: false })
  let generation = 0; let closed = false
  onCleanup(() => { closed = true })
  const load = async () => {
    const client = props.client(); if (!client || !form.provider) return
    const request = ++generation; const id = form.provider; setForm({ loading: true, models: [] })
    try { const models = await client.providerModels({ id }); if (!closed && request === generation) setForm({ models: [...models], model: models.some(model => model.id === form.model) ? form.model : models[0]?.id ?? "" }) }
    catch (error) { if (!closed && request === generation) props.report(error) }
    finally { if (!closed && request === generation) setForm("loading", false) }
  }
  onMount(() => void load())
  const save = async () => { const client = props.client(); if (!client) return; setForm("busy", true); try { await client.selectModel({ role: props.role, providerID: form.provider, modelID: form.model }); props.onDone() } catch (error) { props.report(error) } finally { setForm("busy", false) } }
  return <Dialog fit containerClass="max-w-[520px]"><DialogHeader><DialogTitleGroup title={props.ctx.t(props.role)} /></DialogHeader><DialogBody class="flex flex-col gap-4 px-4 pb-4">
    <Select aria-label={props.ctx.t("providersTitle")} options={providers().map(provider => provider.id)} current={form.provider} disabled={form.busy} onSelect={id => { if (id && id !== form.provider) { setForm({ provider: id, model: "" }); void load() } }} />
    <Select aria-label={props.ctx.t("modelsTitle")} options={form.models.map(model => model.id)} current={form.model} disabled={form.loading || form.busy} onSelect={id => { if (id) setForm("model", id) }} />
    <Button disabled={form.loading || form.busy} onClick={() => void load()}>{props.ctx.t("modelsRefresh")}</Button>
    <Button disabled={form.loading || form.busy || !form.models.some(model => model.id === form.model)} onClick={() => void save()}>{props.ctx.t("configurationSave")}</Button>
  </DialogBody></Dialog>
}
