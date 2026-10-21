import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionDocument } from "@opencode/session-ui/document"
import type { WorkflowSession } from "@opencode/gui-extensions/openagi/contract"
import { legacyWorkflowPrompt } from "@opencode/gui-extensions/openagi/presentation"
import { Button } from "@opencode/ui/button"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { SessionUserMessage } from "@opencode/session-ui/message"
import { SessionTimeline } from "@opencode/session-ui/timeline"
import { ScrollView } from "@opencode/ui/scroll-view"
import { SessionUIProvider } from "@/shell/routes/session-ui-provider"
import { useServer } from "@/runtime/server/current"
import { useLanguage } from "@/runtime/i18n/language"
import { useOpenAGIWorkflow } from "@/runtime/extension/openagi-workflow"
import { ExtensionSlot } from "@/runtime/extension/render"
import { useSettings } from "@/settings/model"
import { readPromptPresentation } from "@/composer/comment-note"
import type { SessionModel } from "./model"
import { SessionIdentityHeader } from "./session-identity-header"
import { WorkflowDelivery } from "./workflow-delivery"
import { WorkflowAcceptanceDetails } from "./workflow-acceptance-details"
import { OpenAGIWorkflowModule } from "./openagi-workflow-module"
import { SessionHeaderSpacer } from "./header/session-header"
import type { MountedSession, SessionScreen } from "@opencode/gui-extensions/sdk"

export function OpenAGIWorkflowTimeline(props: {
  session: SessionModel
  view: MountedSession
  screen: SessionScreen
  reserveReviewToggle: boolean
}) {
  const workflow = useOpenAGIWorkflow()
  const language = useLanguage()
  const settings = useSettings()
  const [store, setStore] = createStore({ limit: 20, pinned: true })
  const modules = createMemo(() => workflow.sessions().slice(-store.limit))
  const summary = () => workflow.project()?.summary ?? workflow.project()?.draftSummary

  const progress = createMemo(() =>
    workflow
      .project()
      ?.messages.findLast((message) => message.role === "assistant")
      ?.text.trim()
      .split("\n")[0]
      ?.slice(0, 320),
  )

  const inputs = createMemo(
    () =>
      workflow
        .project()
        ?.messages.filter((message) => message.role === "user")
        .slice(-20) ?? [],
  )

  let content: HTMLDivElement | undefined
  let observer: ResizeObserver | undefined
  onCleanup(() => observer?.disconnect())

  return (
    <ScrollView
      data-component="openagi-workflow-timeline"
      data-slot="session-timeline-scroll"
      class="size-full"
      viewportRef={(element) => {
        observer = new ResizeObserver(() => {
          if (store.pinned) element.scrollTop = element.scrollHeight
        })

        if (content) observer.observe(content)
      }}
      onScroll={(event) => {
        const element = event.currentTarget
        setStore("pinned", element.scrollHeight - element.clientHeight - element.scrollTop < 24)
      }}
    >
      <SessionIdentityHeader sessionID={props.session.identity.params.id ?? ""} session={props.session.data.info()}>
        <div class="flex-1" />
        <ExtensionSlot at="session.header" input={{ session: props.view, screen: props.screen, active: true }} />
        <SessionHeaderSpacer visible={props.reserveReviewToggle} />
      </SessionIdentityHeader>
      <div
        ref={(element) => {
          content = element
          observer?.observe(element)
        }}
        class="mx-auto flex w-full max-w-[1000px] flex-col px-6 pb-6"
      >
        <For each={inputs()}>
          {(message) => (
            <SessionUserMessage
              sessionID={props.session.identity.params.id ?? ""}
              message={{ id: message.id, type: "user", time: { created: Date.parse(message.at) }, text: message.text }}
            />
          )}
        </For>
        <Show when={summary() && !inputs().some(message => message.text === summary())}>
          <p data-slot="openagi-workflow-goal" class="whitespace-pre-wrap py-3 text-14-regular text-v2-text-text-base">
            {summary()}
          </p>
        </Show>
        <Show when={props.session.history.messages().length}>
          <SessionTimeline
            document={{
              sessionID: props.session.identity.params.id ?? "",
              messages: props.session.history.messages(),
              status: props.session.data.status(),
              diffs: [],
            }}
            timelineDetail={settings.general.timelineDetail()}
          />
        </Show>
        <Show when={workflow.sessions().length > store.limit}>
          <Button
            variant="ghost-muted"
            size="small"
            onClick={() => {
              setStore("pinned", false)
              setStore("limit", (value) => value + 20)
            }}
          >
            {language.t("session.workflow.earlier")}
          </Button>
        </Show>
        <For each={modules()}>
          {(record) => <WorkflowModule record={record} running={workflow.project()?.phase === "running"} />}
        </For>
        <Show when={workflow.project()?.queuedInput}>
          {(count) => (
            <p role="status" class="py-2 text-13-regular text-v2-text-text-muted">
              {language.plural("session.workflow.queued", count())}
            </p>
          )}
        </Show>
        <For each={workflow.project()?.tasks.filter(task => task.run?.acceptanceDetails?.some(item => !item.passed)) ?? []}>
          {task => <WorkflowAcceptanceDetails title={task.title} criteria={task.run?.acceptanceDetails ?? []} />}
        </For>
        <Show when={workflow.project()?.error}>
          {(error) => (
            <p role="alert" class="whitespace-pre-wrap py-3 text-13-regular text-v2-text-text-negative">
              {error()}
            </p>
          )}
        </Show>
        <Show when={workflow.project()?.delivery}>
          {guide => <WorkflowDelivery guide={guide()} directory={workflow.project()?.directory} />}
        </Show>
        <Show when={workflow.project()?.awaitingInput && workflow.project()?.phase === "idle"}>
          <p role="status" class="py-3 text-13-regular text-v2-text-text-muted">{language.t("session.workflow.idle")}</p>
        </Show>
        <Show when={!workflow.project()?.error && !workflow.project()?.awaitingInput && progress()}>
          {(text) => (
            <p
              data-slot="openagi-workflow-progress"
              class="whitespace-pre-wrap py-3 text-13-regular text-v2-text-text-muted"
            >
              {text()}
            </p>
          )}
        </Show>
        <Show
          when={workflow.project()?.phase === "running" && !workflow.project()?.prompt && !workflow.project()?.error}
        >
          <div data-component="session-working" role="status" class="pt-3 text-13-medium">
            <TextShimmer text={language.t("session.timeline.working")} active />
          </div>
        </Show>
      </div>
    </ScrollView>
  )
}

function WorkflowModule(props: { record: WorkflowSession; running: boolean }) {
  const server = useServer()
  const settings = useSettings()
  const language = useLanguage()
  const data = server.ctx.data
  const [store, setStore] = createStore({ visible: false })

  const [ready, { refetch }] = createResource(
    () => (store.visible ? props.record.sessionId : undefined),
    async (id) => {
      await data.session.sync(id)
      await data.session.message.sync(id)

      return true
    },
  )

  const info = () => data.session.get(props.record.sessionId)

  const document = createMemo<SessionDocument>(() => ({
    sessionID: props.record.sessionId,
    messages: data.session.message.list(props.record.sessionId),
    status: data.session.status(props.record.sessionId) === "running" ? { type: "busy" } : { type: "idle" },
    diffs: [],
  }))

  const label = createMemo(() =>
    props.record.label === "observe" &&
    document().messages.some(
      (message) => message.type === "user" && message.text.startsWith("Design executable static/test checks"),
    )
      ? language.t("session.workflow.planning")
      : props.record.label,
  )

  const presentation = createMemo(() =>
    Object.fromEntries(
      document().messages.flatMap((message) => {
        if (message.type !== "user") return []

        const explicit = readPromptPresentation(message.metadata)

        const legacy = explicit?.resultPresentation
          ? undefined
          : legacyWorkflowPrompt({ managed: true, title: info()?.title ?? props.record.label, text: message.text })

        return [
          [
            message.id,
            {
              displayText: explicit?.displayText ?? legacy?.displayText,
              collapsed: explicit?.collapsed ?? legacy?.collapsed,
              resultPresentation: explicit?.resultPresentation ?? legacy?.resultPresentation,
              comments: explicit?.comments,
              references: explicit?.attachments,
            },
          ],
        ]
      }),
    ),
  )

  let observer: IntersectionObserver | undefined
  onCleanup(() => observer?.disconnect())

  return (
    <div
      ref={(element) => {
        observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return
            setStore("visible", true)
            observer?.disconnect()
          },
          { rootMargin: "400px" },
        )
        observer.observe(element)
      }}
    >
      <Show when={ready.error}>
        <Button variant="ghost-muted" size="small" onClick={() => void refetch()}>
          {language.t("session.workflow.retry", { label: props.record.label })}
        </Button>
      </Show>
      <SessionUIProvider
        directory={info()?.location.directory ?? props.record.directory}
        server={server.key}
        sessionID={props.record.sessionId}
      >
        <OpenAGIWorkflowModule
          label={label()}
          document={document()}
          invocationOutcome={props.record.outcome === "running" && !props.running ? undefined : props.record.outcome}
          presentation={presentation()}
          timelineDetail={settings.general.timelineDetail()}
          history={
            <Show when={data.session.message.more(props.record.sessionId)}>
              <Button
                variant="ghost-muted"
                size="small"
                disabled={data.session.message.loading(props.record.sessionId)}
                onClick={() => void data.session.message.loadMore(props.record.sessionId)}
              >
                {language.t("session.workflow.earlier")}
              </Button>
            </Show>
          }
        />
      </SessionUIProvider>
    </div>
  )
}
