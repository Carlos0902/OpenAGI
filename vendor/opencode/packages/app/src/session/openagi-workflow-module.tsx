import { createMemo, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { BasicTool } from "@opencode/session-ui/basic-tool"
import { SessionTimeline, type SessionUserPresentation } from "@opencode/session-ui/timeline"
import type { SessionDocument } from "@opencode/session-ui/document"
import type { TimelineDetail } from "@opencode/session-ui/timeline/detail"
import { useLanguage } from "@/runtime/i18n/language"

/** Reuse the same transcript and disclosures as a native session, without routing to a child tab. */
export function OpenAGIWorkflowModule(props: {
  label: string
  document: SessionDocument
  /** Actual orchestrator request outcome, including work after the native model reply. */
  invocationOutcome?: "running" | "succeeded" | "failed" | "interrupted"
  presentation?: Record<string, SessionUserPresentation | undefined>
  timelineDetail?: TimelineDetail
  history?: JSX.Element
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({ open: false })
  const busy = () => props.invocationOutcome === "running" || props.document.status.type === "busy"

  const latest = createMemo(() =>
    props.document.messages.findLast((message) => message.type === "idle" || message.type === "assistant"),
  )

  const failed = () => {
    if (props.invocationOutcome) return props.invocationOutcome === "failed"

    if (busy()) return false

    const message = latest()

    return message?.type === "idle" ? message.outcome === "failed" : message?.type === "assistant" && !!message.error
  }

  const interrupted = () => {
    if (props.invocationOutcome) return props.invocationOutcome === "interrupted"

    if (busy()) return false

    const message = latest()

    return message?.type === "idle" && message.outcome === "interrupted"
  }

  const status = () =>
    failed()
      ? language.t("session.workflow.failed")
      : interrupted()
        ? language.t("ui.message.interrupted")
        : busy()
          ? language.t("session.timeline.working")
          : props.document.messages.length
            ? language.t("session.workflow.finished")
            : language.t("session.messages.loading")

  const detail = () => props.timelineDetail

  const reasoning = () =>
    detail()?.thinking.placement === "hidden"
      ? "hidden"
      : detail()?.thinking.details === "expanded"
        ? "full"
        : "compact"

  const timeline = (preview: boolean) => (
    <SessionTimeline
      document={props.document}
      presentation={props.presentation}
      preview={preview}
      reasoningMode={reasoning()}
      shellToolDefaultOpen={detail()?.shell.details === "expanded"}
      editToolDefaultOpen={detail()?.edit.details === "expanded"}
      timelineDetail={detail()}
    />
  )

  return (
    <section data-component="openagi-workflow-module" data-session-id={props.document.sessionID} class="min-w-0 py-2">
      <BasicTool
        icon="mcp"
        status={failed() ? "error" : interrupted() ? "interrupted" : busy() ? "running" : "completed"}
        trigger={{
          title: props.label.startsWith("Tutor · ") ? props.label : props.label.split(" · ")[0]!,
          subtitle: status(),
        }}
        hasContent
        allowOpenWhilePending
        defer
        compact
        open={store.open}
        onOpenChange={(open) => setStore("open", open)}
      >
        <Show when={store.open}>
          {props.history}
          {timeline(false)}
        </Show>
      </BasicTool>
      <Show when={!store.open}>{timeline(true)}</Show>
    </section>
  )
}
