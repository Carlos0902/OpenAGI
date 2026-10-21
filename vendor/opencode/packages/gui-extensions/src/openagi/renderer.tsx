import { Markdown } from "@opencode/session-ui/markdown"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Switch } from "@opencode/ui/switch"
import { createStore } from "solid-js/store"
import { TextInput } from "@opencode/ui/text-input"
import { showToast } from "@opencode/ui/toast"
import { createMemo, createSignal, lazy, Suspense, For, onCleanup, Show, type Accessor } from "solid-js"
import {
  Command,
  createKeyed,
  ProjectManager,
  Server,
  SettingsPage,
  type IpcClient,
  type Setup,
  type SetupContext,
} from "../sdk"
import { OPEN_SESSION_EVENT, OpenAGI, type WorkflowProject, type WorkflowSession } from "./contract"
import type definition from "./index"
import { closedWorkflowProject, shouldFocusWorkflowSession, workflowProjectForSession } from "./lifecycle"
import { createWorkflowProjectManager } from "./project-manager"

type Client = IpcClient<typeof OpenAGI.spec>

type Context = SetupContext<typeof definition>

const ConfigurationSettings = lazy(() => import("./configuration-settings"))

const UsageSettings = lazy(() => import("./usage-settings"))

/** Opens the actual upstream session route; its event stream owns thinking, tools, permissions and forms. */
function openSession(session: WorkflowSession) {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { ...session, sessionId: session.mainSessionId ?? session.sessionId, revealSessionId: session.mode === "workflow" ? undefined : session.sessionId } }))
}

const setup: Setup<typeof definition> = (ctx) => {
  if (ctx.build.platform !== "desktop") return
  const live = ctx.uses.workflow

  const client = (): Client | undefined => {
    const current = live()

    return current.status === "active" ? current.value : undefined
  }

  const state = () => client()?.state()
  const [selectedDirectory, selectDirectory] = createSignal<string>()
  const incomingSelection = createMemo(() => state()?.selectedProject)
  // CLI/Finder activation selects a project only; a stable value never reclaims focus from user navigation.
  createKeyed(incomingSelection, selectDirectory)

  const directory = () =>
    selectedDirectory() ?? ctx.sessions.current()?.project?.worktree ?? state()?.projects[0]?.directory

  // A deliberate picker selection wins until the user actually navigates to another native session.
  createKeyed(
      () => ctx.sessions.current()?.visit,
      () => {
        const session = ctx.sessions.current()

        if (!session) return
        selectDirectory(
          workflowProjectForSession(state(), session)?.directory ?? session.project?.worktree ?? session.directory,
        )
      },
  )
  const project = () => state()?.projects.find((item) => item.directory === directory())
  let knownProjects = new Set<string>()
  // Reconcile the picker with projects removed by the native host.
  createKeyed(() => state()?.projects, (projects) => {
    const next = new Set(projects.map((project) => project.directory))
    const selected = selectedDirectory()

    if (selected && knownProjects.has(selected) && !next.has(selected)) selectDirectory(undefined)
    knownProjects = next
  })

  const report = (cause: unknown) =>
    showToast({
      variant: "error",
      title: ctx.t("failed"),
      description: cause instanceof Error ? cause.message : String(cause),
    })

  // Report workflow failures even when the user is viewing a completed Tutor session.
  createKeyed(() => project()?.error, (error) => report(new Error(error)))
  const request = (operation: () => Promise<void>) => void operation().catch(report)

  const choose = async () => {
    const target = await manager.choose()

    return target?.directory
  }

  const selected = async () => directory() ?? (await choose())

  const showWorkflow = (target: string) => {
    ctx.dialogs.open(dialog => <WorkflowDetailsDialog
      ctx={ctx} project={() => state()?.projects.find(project => project.directory === target)} client={client}
      report={report} onDone={dialog.close} start={() => start()} configure={() => configure(target)}
    />)
  }

  const start = async (summary?: string) => {
    const requested = await selected()

    if (!requested || ctx.signal.aborted) return
    selectDirectory(requested)
    const opened = await client()?.project({ directory: requested })

    if (ctx.signal.aborted) return

    if (!opened) return
    const target = opened.directory
    selectDirectory(target)
    const current = () => state()?.projects.find((item) => item.directory === target)

    if (!current()?.config) return configure(target)

    if (summary?.trim()) {
      await client()?.run({ directory: target, summary })

      return
    }

    const mainSessionId = current()?.mainSessionId
    const server = state()?.servers.find((item) => item.directory === target)

    if (mainSessionId && server) openSession({
      serverId: server.id, directory: target, sessionId: mainSessionId,
      mainSessionId, mode: "workflow", label: `OpenAGI · ${current()?.name ?? ""}`,
    })
  }

  const configure = async (_target?: string) => { ctx.layout.settings("providers") }

  const manager = createWorkflowProjectManager({
    state,
    client,
    select: selectDirectory,
    start: () => start(),
    signal: ctx.signal,
  })

  ctx.add(ProjectManager, manager)

  createKeyed(live, (ipc) =>
    ipc.on("session", (session) => {
      const focus = shouldFocusWorkflowSession(session, selectedDirectory())

      if (focus || !selectedDirectory()) selectDirectory(session.directory)

      if (focus && session.mode === "workflow") openSession(session)
    }),
  )
  ctx.workspaces.on("remove", ({ directory }) => {
    if (state()?.projects.some((project) => project.directory === directory))
      request(() => client()!.pause({ directory }))
  })

  const closed = (event: Event) => {
    const directory = closedWorkflowProject(event instanceof CustomEvent ? event.detail : undefined, state()?.servers ?? [])

    if (directory) request(() => client()!.pause({ directory }))
  }

  window.addEventListener("openagi:project-closed", closed)
  onCleanup(() => window.removeEventListener("openagi:project-closed", closed))
  // Retire the old automatically inserted workflow tab once per restored session.
  createKeyed(() => {
    const session = ctx.sessions.current()

    return session && ctx.layout.ready() && ctx.layout.stored(session).includes("workflow") ? session : undefined
  }, session => {
    ctx.layout.close(`${ctx.id}:workflow`, session)

    if (ctx.layout.side.opened(session)) ctx.layout.side.toggle(session)
  })

  ctx.add(Server, () => ({
    ready: !!state(),
    order: -10,
    entries: (state()?.servers ?? []).map((server) => ({
      id: server.id.startsWith("openagi:") ? server.id.slice("openagi:".length) : server.id,
      name: server.name,
      label: "OpenAGI",
      presentation: "project" as const,
      projectDirectory: server.directory,
      state: server.state === "connected" ? ("ready" as const) : server.state,
      http: server.http,
      connect: async () => {
        await client()!.project({ directory: server.directory })

        return (
          client()
            ?.state()
            ?.servers.find((item) => item.id === server.id)?.state === "connected"
        )
      },
      remove: () => client()!.forget({ directory: server.directory }),
    })),
  }))
  ctx.add(Command, {
    id: "start",
    title: ctx.t("start"),
    group: "OpenAGI",
    featured: true,
    slash: { name: "openagi", arguments: true },
    run: async (summary) => {
      try {
        await start(summary)
      } catch (error) {
        report(error)
      }
    },
  })
  ctx.add(Command, {
    id: "pause",
    title: ctx.t("pause"),
    group: "OpenAGI",
    get enabled() {
      return !!project() && project()?.phase !== "idle"
    },
    run: () => {
      const target = directory()

      if (target) request(() => client()!.pause({ directory: target }))
    },
  })
  ctx.add(Command, {
    id: "settings",
    title: ctx.t("settings"),
    group: "OpenAGI",
    run: () => ctx.layout.settings("providers"),
  })
  ctx.add(Command, {
    id: "tasks",
    title: ctx.t("tasks"),
    group: "OpenAGI",
    get enabled() { return !!project() },
    run: () => { const target = directory();

 if (target) showWorkflow(target) },
  })
  ctx.add(Command, {
    id: "usage",
    title: ctx.t("usageTitle"),
    group: "OpenAGI",
    run: () => ctx.layout.settings("openagi-usage"),
  })
  ctx.add(SettingsPage, {
    id: "openagi-usage",
    title: ctx.t("usageTitle"),
    available: "desktop",
    render: () => <Suspense><UsageSettings ctx={ctx} projects={() => state()?.projects ?? []} directory={directory} /></Suspense>,
  })

  for (const page of ["providers", "models"] as const) {
    ctx.add(SettingsPage, {
      id: `openagi-${page}`,
      page,
      replace: true,
      title: ctx.t(page === "providers" ? "providersTitle" : "modelsTitle"),
      available: "desktop",
      entries: page === "providers" ? [
        { id: "provider-typesafe", title: "TypeSafe", keywords: "typesafe jev api key" },
        { id: "openagi-network", title: ctx.t("network"), keywords: "network proxy http https" },
      ] : [
        { id: "openagi-heavy", title: ctx.t("heavy"), keywords: "heavy model" },
        { id: "openagi-light", title: ctx.t("light"), keywords: "light model" },
        { id: "openagi-jev", title: ctx.t("jev"), keywords: "typesafe jev" },
      ],
      render: () => <Suspense><ConfigurationSettings ctx={ctx} client={client} page={page} network={() => <NetworkSettings ctx={ctx} client={client} report={report} />} report={report} /></Suspense>,
    })
  }

}

export default setup

function WorkflowDetailsDialog(props: Parameters<typeof WorkflowPanel>[0] & { onDone: () => void }) {
  return <Dialog fit containerClass="max-w-[640px]">
    <DialogHeader><DialogTitleGroup title={props.ctx.t("tasks")} description={props.project()?.name} /></DialogHeader>
    <DialogBody class="max-h-[70dvh] overflow-y-auto"><WorkflowPanel {...props} start={async () => { props.onDone(); await props.start() }} configure={async () => { props.onDone(); await props.configure() }} /></DialogBody>
  </Dialog>
}

function WorkflowPanel(props: {
  ctx: Context
  project: Accessor<WorkflowProject | undefined>
  client: Accessor<Client | undefined>
  report: (cause: unknown) => void
  start: () => Promise<void>
  configure: () => Promise<void>
}) {
  const request = (operation: () => Promise<void>) => void operation().catch(props.report)

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div class="flex items-center justify-between">
        <span class="text-[13px] font-medium">OpenAGI</span>
        <Show when={!!props.project() && props.project()?.phase !== "idle"}>
          <Button
            size="small"
            onClick={() => request(() => props.client()!.pause({ directory: props.project()!.directory }))}
          >
            {props.ctx.t("pause")}
          </Button>
        </Show>
      </div>
      <Show
        when={props.project()}
        fallback={<p class="text-12-regular text-v2-text-text-muted">{props.ctx.t("missing")}</p>}
      >
        {(project) => (
          <>
            <p class="text-12-regular text-v2-text-text-muted">{project().summary ?? props.ctx.t("description")}</p>
            <Show when={project().phase === "idle"}>
              <Button onClick={() => request(props.start)}>{props.ctx.t("start")}</Button>
              <Show when={!project().config}>
                <Button onClick={() => request(props.configure)}>{props.ctx.t("configure")}</Button>
              </Show>
            </Show>
            <Show when={project().error}>
              {(error) => (
                <div role="alert" class="flex flex-col gap-2 text-12-regular text-v2-state-fg-danger">
                  <p>{error()}</p>
                  <Button size="small" onClick={() => request(props.configure)}>{props.ctx.t("configure")}</Button>
                </div>
              )}
            </Show>
            <For
              each={project()
                .messages.filter((item) => item.role !== "user")
                .slice(-2)}
            >
              {(message) => <Markdown text={message.text} />}
            </For>
            <section class="flex flex-col gap-2">
              <h3 class="text-12-regular text-v2-text-text-muted">{props.ctx.t("tasks")}</h3>
              <For each={project().tasks}>
                {(task) => (
                  <details class="text-12-regular">
                    <summary class="cursor-pointer">
                      {task.title} · {task.status}
                    </summary>
                    <Markdown
                      text={`${task.description}\n\n${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`}
                    />
                    <For each={task.run?.checks}>
                      {(check) => (
                        <div class="flex items-center gap-2">
                          <Icon name={check.ok ? "check" : "close"} size="small" />
                          {check.name}
                        </div>
                      )}
                    </For>
                    <Show when={task.run?.acceptance}>{(acceptance) => <Markdown text={acceptance()} />}</Show>
                    <Show when={task.run?.error}>
                      {(error) => (
                        <p role="alert" class="text-v2-state-fg-danger">
                          {error()}
                        </p>
                      )}
                    </Show>
                  </details>
                )}
              </For>
            </section>
          </>
        )}
      </Show>
    </div>
  )
}


function NetworkSettings(props: { ctx: Context; client: Accessor<Client | undefined>; report: (cause: unknown) => void }) {
  const [form, setForm] = createStore({ proxyURL: "http://127.0.0.1:7892", enabled: true, dirty: false, busy: false, message: "", ok: true })
  const saved = () => props.client()?.state()?.network
  const proxyURL = () => form.dirty ? form.proxyURL : saved()?.proxyURL ?? form.proxyURL
  const enabled = () => form.dirty ? form.enabled : saved()?.enabled ?? form.enabled
  const change = (update: { proxyURL?: string; enabled?: boolean }) => setForm({ proxyURL: proxyURL(), enabled: enabled(), ...update, dirty: true, message: "" })

  const save = async () => {
    const client = props.client()

    if (!client) return
    await client.networkConfig({ enabled: enabled(), proxyURL: proxyURL(), noProxy: saved()?.noProxy ?? "localhost,127.0.0.1,::1" })
    setForm({ dirty: false, message: props.ctx.t("networkSaved"), ok: true })
  }

  const run = async (test: boolean) => {
    setForm({ busy: true, message: "" })

    try {
      if (form.dirty || !saved()) await save()

      if (test) {
        const result = await props.client()?.testNetwork()

        if (result) setForm({ message: result.message, ok: result.ok })
      } else if (!form.message) setForm({ message: props.ctx.t("networkSaved"), ok: true })
    } catch (error) { props.report(error) }
    finally { setForm("busy", false) }
  }

  return (
    <section class="settings-section" data-action="openagi-network">
      <h3 class="text-13-medium">{props.ctx.t("network")}</h3>
      <p class="text-12-regular text-v2-text-text-muted">{props.ctx.t("networkDescription")}</p>
      <Switch checked={enabled()} disabled={form.busy} onChange={(enabled) => change({ enabled })}>{props.ctx.t("networkEnable")}</Switch>
      <TextInput aria-label={props.ctx.t("networkAddress")} placeholder="http://127.0.0.1:7892" value={proxyURL()} disabled={form.busy} onInput={(event) => change({ proxyURL: event.currentTarget.value })} />
      <div class="flex gap-2">
        <Button disabled={form.busy || !props.client()} onClick={() => void run(false)}>{props.ctx.t("networkSave")}</Button>
        <Button disabled={form.busy || !props.client()} onClick={() => void run(true)}>{props.ctx.t("networkTest")}</Button>
      </div>
      <Show when={form.message}><p role={form.ok ? "status" : "alert"} classList={{ "text-v2-state-fg-danger": !form.ok }} class="text-12-regular">{form.message}</p></Show>
    </section>
  )
}
