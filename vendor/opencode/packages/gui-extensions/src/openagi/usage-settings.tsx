import { createMemo, For, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { SetupContext } from "../sdk"
import type definition from "./index"
import type { WorkflowProject } from "./contract"

export default function UsageSettings(props: {
  ctx: Pick<SetupContext<typeof definition>, "t">
  projects: Accessor<readonly WorkflowProject[]>
  directory: Accessor<string | undefined>
}) {
  const [view, setView] = createStore<{ scope?: string }>({})
  const scope = () => view.scope ?? props.directory() ?? "*"
  const projects = createMemo(() => props.projects().filter(project => scope() === "*" || project.directory === scope()))

  const rows = createMemo(() => {
    const models = new Map<string, NonNullable<WorkflowProject["usage"]>["models"][number]>()

    for (const project of projects()) {
      for (const row of project.usage?.models ?? []) {
        const key = JSON.stringify([row.providerID, row.modelID])
        const previous = models.get(key)
        models.set(key, previous ? {
          ...row, requests: previous.requests + row.requests, unreported: previous.unreported + row.unreported,
          input: previous.input + row.input, output: previous.output + row.output, reasoning: previous.reasoning + row.reasoning,
          cache: { read: previous.cache.read + row.cache.read, write: previous.cache.write + row.cache.write }, total: previous.total + row.total,
        } : row)
      }
    }

    return [...models.values()].sort((a, b) => b.total - a.total || a.modelID.localeCompare(b.modelID))
  })

  const number = (value: number) => value.toLocaleString()
  const sum = (field: "total" | "requests" | "unreported") => number(rows().reduce((total, row) => total + row[field], 0))

  return <div class="mx-auto flex w-full max-w-[1100px] flex-col gap-6 p-6 select-text">
    <div class="flex flex-col gap-2">
      <h2 class="text-16-medium">{props.ctx.t("usageTitle")}</h2>
      <p class="text-13-regular text-v2-text-text-muted">{props.ctx.t("usageDescription")}</p>
    </div>
    <label class="flex flex-col gap-2 text-13-regular">
      {props.ctx.t("usageScope")}
      <select class="h-9 max-w-full rounded-md border border-v2-border-border-base bg-v2-background-bg-base px-3" value={scope()} onChange={event => setView("scope", event.currentTarget.value)}>
        <option value="*">{props.ctx.t("usageAll")}</option>
        <For each={props.projects()}>{project => <option value={project.directory}>{project.name} · {project.directory}</option>}</For>
      </select>
    </label>
    <div class="grid grid-cols-3 gap-4">
      <For each={[["usageTotal", sum("total")], ["usageSteps", sum("requests")], ["usageUnreported", sum("unreported")]] as const}>{item =>
        <div class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base p-4">
          <span class="text-12-regular text-v2-text-text-muted">{props.ctx.t(item[0])}</span>
          <strong class="text-[24px] leading-8 font-medium tabular-nums">{item[1]}</strong>
        </div>
      }</For>
    </div>
    <Show when={projects().some(project => project.usage?.error)}><p role="alert" class="text-13-regular text-v2-state-fg-danger">{props.ctx.t("usageUnavailable")}</p></Show>
    <Show when={rows().length} fallback={<p class="text-13-regular text-v2-text-text-muted">{props.ctx.t("usageEmpty")}</p>}>
      <div class="overflow-x-auto rounded-lg border border-v2-border-border-base">
        <table class="w-full text-13-regular tabular-nums">
          <thead><tr class="border-b border-v2-border-border-base text-v2-text-text-muted">
            <For each={["usageModel", "usageSteps", "usageInput", "usageOutput", "usageReasoning", "usageCacheRead", "usageCacheWrite", "usageTotal", "usageUnreported"] as const}>{key => <th scope="col" class="whitespace-nowrap p-3 text-start font-medium">{props.ctx.t(key)}</th>}</For>
          </tr></thead>
          <tbody><For each={rows()}>{row => <tr class="border-b border-v2-border-border-base last:border-0">
            <th scope="row" class="p-3 text-start font-normal"><div>{row.modelID}</div><div class="text-12-regular text-v2-text-text-muted">{row.providerID}</div></th>
            <For each={[row.requests, row.input, row.output, row.reasoning, row.cache.read, row.cache.write, row.total, row.unreported]}>{value => <td class="p-3 text-end">{number(value)}</td>}</For>
          </tr>}</For></tbody>
        </table>
      </div>
    </Show>
    <p class="text-12-regular text-v2-text-text-muted">{props.ctx.t("usageNote")}</p>
  </div>
}
