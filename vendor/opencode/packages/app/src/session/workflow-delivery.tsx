import { Show } from "solid-js"
import { Markdown } from "@opencode/session-ui/markdown"
import { useLanguage } from "@/runtime/i18n/language"

export function WorkflowDelivery(props: { directory?: string; guide: { markdown: string; source?: string } }) {
  const language = useLanguage()
  return <section class="py-4 select-text">
    <p class="text-14-medium pb-2">{language.t("session.workflow.deliveryComplete")}</p>
    <p class="text-14-medium pb-2">{language.t("session.workflow.usage")}</p>
    <Show when={props.directory}>{directory => <p class="pb-2 text-13-regular">{language.t("session.workflow.projectFolder", { directory: directory() })}</p>}</Show>
    <Show when={props.guide.markdown} fallback={<p class="text-13-regular text-v2-text-text-muted">{language.t("session.workflow.usageMissing")}</p>}>
      <Markdown text={props.guide.markdown} />
    </Show>
    <Show when={props.guide.source}>{source => <p class="pt-2 text-12-regular text-v2-text-text-muted">{language.t("session.workflow.usageSource", { source: source() })}</p>}</Show>
  </section>
}
