import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"

/** Failed requirements and nonblocking measurements retain the independent reviewer's actual evidence. */
export function WorkflowAcceptanceDetails(props: {
  title: string
  criteria: readonly { criterion: string; passed: boolean; evidence: string; kind: "requirement" | "measurement" }[]
}) {
  const language = useLanguage()
  return <Show when={props.criteria.some(item => !item.passed)}>
    <section class="py-3 text-13-regular">
      <p class="pb-2 text-14-medium">{props.title}</p>
      <For each={props.criteria.filter(item => !item.passed)}>
        {item => <div class="whitespace-pre-wrap py-2" classList={{ "text-v2-text-text-negative": item.kind === "requirement", "text-v2-text-text-muted": item.kind === "measurement" }}>
          <p class="font-medium">{language.t(item.kind === "measurement" ? "session.workflow.measurement" : "session.workflow.unmet")}: {item.criterion}</p>
          <p>{item.evidence}</p>
        </div>}
      </For>
    </section>
  </Show>
}
