import { quantitativePerformanceTarget } from "./performance-policy.js";
import { constants, copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { BrowserConversation } from "./conversation.js";
import { ProjectStore } from "./store.js";
import { configuredBackend } from "./backend.js";
import { OpenCodeRuntime, type OpenCodeOptions } from "./opencode.js";
import { ConfiguredRuntime } from "./configured-runtime.js";
import { InteractiveSession } from "./session.js";
import { configurationWizard } from "./config-wizard.js";
import { loadSettings, applySettings, settingsSecrets, type LoadedSettings } from "./settings.js";
import type { WebMessage, WebPrompt, WebTask } from "./web-types.js";
import { ConfigurationEditor, type ProviderEdit, type ConfigurationView } from "./config-editor.js";
import { DEFAULT_PROXY, loadNetworkProfile, saveNetworkProfile, applyNetworkProfile, loopbackNoProxy, type NetworkProfile } from "./network-profile.js";
import { validateTypesafeKey } from "./typesafe.js";
import type { AgentRuntime, WorkflowStage } from "./runtime.js";
import { withinProject } from "./boundary.js";
import { z } from "zod";
import { ProjectInputQueue } from "./input-queue.js";
import { UsageTracker, type UsageSummary } from "./usage.js";

const WorkflowView = z.object({ version: z.literal(1), directory: z.string(), sessionId: z.string().regex(/^ses[a-zA-Z0-9_-]+$/) });

export interface NativeSession { serverId: string; directory: string; sessionId: string; mainSessionId?: string; mode: string; purpose?: string; label: string; focus?: boolean; outcome?: "running" | "succeeded" | "failed" | "interrupted" }
export interface NativeProject {
  usage?: UsageSummary;
  directory: string; name: string; summary?: string; draftSummary?: string; phase: "idle" | "running" | "configuring" | "stopping";
  delivery?: import("./domain.js").State["delivery"]; awaitingInput?: boolean; mainSessionId?: string; queuedInput?: number; error?: string; prompt?: WebPrompt; activity?: WorkflowStage; messages: WebMessage[]; tasks: WebTask[]; config?: { heavy: string; light: string };
}
export interface NativeState {
  configuration?: ConfigurationView;
  network?: NetworkProfile;
  selectedProject?: string;
  projects: NativeProject[];
  servers: { id: string; directory: string; name: string; state: "connected" | "starting" | "stopped"; http?: { url: string; username: string; password: string } }[];
  sessions: NativeSession[];
}
type Backend = Awaited<ReturnType<typeof configuredBackend>>;
type Project = {
  value: NativeProject; id: string; store: ProjectStore; loaded?: LoadedSettings;
  inputs: ProjectInputQueue; history: WebMessage[]; inputEpoch?: string;
  backend?: Backend; opening?: Promise<void>; operation?: Promise<void>; stopping?: Promise<void>;
  configurationSignature?: string;
  usage: UsageTracker; usageAt?: number;
  life: AbortController; controller: AbortController; io: BrowserConversation;
};
let options: { cli?: string; appData?: string } = {};
let singleton: OpenAGIBridge | undefined;
let initialized = false;
let shuttingDown = false;
const pendingLaunches: string[][] = [];
function currentBridge() {
  if (shuttingDown) throw new Error("OpenAGI is shutting down");
  if (!singleton || singleton.closed) singleton = new OpenAGIBridge(options);
  return singleton;
}
/** CLI launches select and prefill a project, without admitting a model turn. */
export async function acceptOpenagiLaunch(argv: string[]): Promise<void> {
  if (shuttingDown) throw new Error("OpenAGI is shutting down");
  if (!initialized) { pendingLaunches.push([...argv]); return; }
  const index = argv.indexOf("--project"); const directory = index >= 0 ? argv[index + 1] : undefined;
  if (!directory) return;
  const bridge = currentBridge(); await bridge.project(directory);
  const summary = argv.indexOf("--summary"); if (summary >= 0 && argv[summary + 1]) await bridge.prefill(directory, argv[summary + 1]!);
}
export async function initializeOpenagiNative(input: { cli?: string; appData?: string }): Promise<void> {
  options = input; initialized = true;
  await acceptOpenagiLaunch(process.argv);
  for (const argv of pendingLaunches.splice(0)) await acceptOpenagiLaunch(argv);
}
export async function createOpenAGIBridge(input: { cli?: string; signal?: AbortSignal } = {}): Promise<OpenAGIBridge> {
  if (shuttingDown) throw new Error("OpenAGI is shutting down");
  input.signal?.throwIfAborted();
  if (!singleton || singleton.closed) singleton = new OpenAGIBridge({ ...options, ...input });
  const bridge = singleton;
  await bridge.initializeNetwork();
  input.signal?.addEventListener("abort", () => { void bridge.close(); }, { once: true });
  return bridge;
}
/** The native main host grants local-only capabilities solely to owned live endpoints. */
export function ownsOpenagiServer(id: string, url: string): boolean { return singleton?.ownsServer(id, url) ?? false; }
/** App-level cleanup also owns bootstrap backends when the GUI extension is disabled. */
export async function shutdownOpenagiNative(): Promise<void> { shuttingDown = true; await singleton?.close(); }
export async function installOpenagiCLI(input: { executable: string; appData?: string }): Promise<string> {
  const directory = join(homedir(), ".local", "bin"); await mkdir(directory, { recursive: true });
  const file = join(directory, "openagi"); const executable = `'${input.executable.replace(/'/g, "'\\''")}'`;
  await writeFile(file, `#!/bin/sh\nif [ "$1" = "run" ] || [ "$1" = "desktop" ]; then shift; fi\nexec ${executable} --project "$PWD" "$@"\n`, { mode: 0o755 });
  return file;
}

/** The original extension host owns IPC; this bridge owns only OpenAGI flow.
 * Native clients subscribe to real OpenCode sessions, never synthesized parts. */
export class OpenAGIBridge {
  private projects = new Map<string, Project>();
  private readonly editor = new ConfigurationEditor();
  private configuration?: ConfigurationView;
  private editing?: Promise<void>;
  private network: NetworkProfile = { enabled: true, proxyURL: DEFAULT_PROXY, noProxy: loopbackNoProxy() };
  private networkReady?: Promise<void>;
  private draining = new Map<string, Promise<void>>();
  private selectedProject?: string;
  private sessions = new Map<string, NativeSession>();
  private listeners = new Set<() => void>();
  private sessionListeners = new Set<(session: NativeSession) => void>();
  private closing?: Promise<void>;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private input: { cli?: string; appData?: string; signal?: AbortSignal } = {}) {
    this.timer = setInterval(() => { void this.refresh(); }, 500); this.timer.unref?.();
  }
  async initializeNetwork(): Promise<void> {
    await (this.networkReady ??= loadNetworkProfile(this.input.appData).then(profile => { this.network = profile; return this.refresh(); }));
  }
  private editable(): void {
    if (this.closing) throw new Error("OpenAGI is closing");
    if (this.editing) throw new Error("全局配置正在保存，请稍后再试。");
    if ([...this.projects.values()].some(project => project.operation || project.stopping)) throw new Error("请先暂停正在运行的项目，再修改全局配置。");
  }
  private async edit(operation: () => Promise<void>): Promise<void> {
    this.editable(); this.editing = operation().then(() => this.refresh());
    try { await this.editing; } finally { this.editing = undefined; }
  }
  async saveProvider(input: ProviderEdit) { await this.edit(() => this.editor.provider(input)); }
  async removeProvider(id: string) { await this.edit(() => this.editor.remove(id)); }
  async providerModels(id: string) { return this.editor.models(id); }
  async selectModel(role: "heavy" | "light", ref: { providerID: string; modelID: string }) { await this.edit(() => this.editor.select(role, ref)); }
  async saveJev(apiKey: string) { await this.edit(() => this.editor.jev(apiKey)); }
  async networkConfig(input: NetworkProfile): Promise<void> {
    this.editable();
    if ([...this.projects.values()].some(project => project.operation || project.stopping)) throw new Error("请先暂停正在运行的项目，再保存全局代理配置。");
    this.network = await saveNetworkProfile(input, this.input.appData);
    applyNetworkProfile(this.network); this.emit();
    // Idle workers inherit the saved proxy on their next explicit start.
  }
  async testNetwork(): Promise<{ ok: boolean; message: string }> {
    try { const loaded = await loadSettings("."); await validateTypesafeKey(loaded.jevKey); return { ok: true, message: "TypeSafe 连接与密钥校验通过。" }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : "TypeSafe 请求未完成。" }; }
  }
  get closed() { return !!this.closing; }
  ownsServer(id: string, url: string): boolean {
    if (this.closed) return false;
    try {
      const origin = new URL(url).origin;
      return [...this.projects.values()].some(project => !project.life.signal.aborted && project.id === id && !!project.backend && new URL(project.backend.server.url).origin === origin);
    } catch { return false; }
  }
  state(): NativeState {
    return { configuration: this.configuration, network: this.network, selectedProject: this.selectedProject, projects: [...this.projects.values()].map(project => {
      const current = new Set(project.io.messages.map(message => message.id));
      const pending = project.inputs.entries.filter(entry => !current.has(entry.id)).map(entry => ({ ...entry, role: "user" as const }));
      pending.forEach(entry => current.add(entry.id));
      const history = project.history.filter(message => !current.has(message.id));
      return JSON.parse(JSON.stringify({ ...project.value, error: project.io.failure ?? (project.value.phase === "idle" ? project.value.error : undefined), prompt: project.io.prompt, activity: project.io.stage, queuedInput: project.inputs.count, messages: [...history, ...pending, ...project.io.messages].sort((a, b) => a.at.localeCompare(b.at)) }, (_key, value) => typeof value === "string" ? project.io.redact(value) : value)) as NativeProject;
    }),
      servers: [...this.projects.values()].map(project => ({ id: project.id, directory: project.value.directory, name: `OpenAGI · ${project.value.name}`, state: project.backend ? "connected" as const : project.opening ? "starting" as const : "stopped" as const, http: project.backend ? { url: project.backend.server.url, username: "opencode", password: project.backend.server.password } : undefined })),
      sessions: [...this.sessions.values()] };
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onSession(listener: (session: NativeSession) => void) { this.sessionListeners.add(listener); return () => { this.sessionListeners.delete(listener); }; }
  /** Restore ownership metadata after the original client restores its tabs.
   * Session contents and execution state remain in the original backend. */
  async rememberSessions(sessions: readonly NativeSession[]): Promise<void> {
    const linked: { project: Project; session: NativeSession }[] = [];
    for (const session of sessions) {
      const project = this.projects.get(session.directory);
      if (!project || project.id !== session.serverId || !/^ses[a-zA-Z0-9_-]+$/.test(session.sessionId)) continue;
      if (session.mode === "workflow" && session.sessionId !== project.value.mainSessionId) continue;
      if (project.backend && project.value.mainSessionId && session.mode !== "workflow") { linked.push({ project, session }); continue; }
      this.sessions.set(`${project.id}:${session.sessionId}`, { ...session, mainSessionId: project.value.mainSessionId, focus: false });
    }
    this.emit();
    for (const { project, session } of linked) {
      project.life.signal.throwIfAborted();
      const server = project.backend!.server;
      const runtime = new OpenCodeRuntime({ baseUrl: server.url, password: server.password, workspaceRoot: project.value.directory, signal: project.life.signal });
      try {
        await runtime.linkWorkflowSession(session.sessionId, { mainSessionId: project.value.mainSessionId!, directory: project.value.directory, mode: session.mode, label: session.label });
        this.sessions.set(`${project.id}:${session.sessionId}`, { ...session, mainSessionId: project.value.mainSessionId, focus: false });
      } catch { project.life.signal.throwIfAborted(); this.sessions.delete(`${project.id}:${session.sessionId}`); /* A missing or foreign transcript cannot become a member of this project. */ }
    }
    this.emit();
  }
  async prefill(directory: string, summary: string) { const project = await this.require(directory); project.value.draftSummary = summary; this.emit(); }
  private emit() { this.listeners.forEach(listener => listener()); }
  private async refresh() {
    if (this.refreshing || this.closing) return; this.refreshing = true;
    try {
      this.configuration = await this.editor.view();
      let globalSettings: LoadedSettings | undefined;
      if (this.projects.size) { try { globalSettings = await loadSettings("."); } catch { /* Configuration UI remains available. */ } }
      for (const project of this.projects.values()) {
        if (project.backend && Date.now() - (project.usageAt ?? 0) >= 5_000) {
          project.usageAt = Date.now();
          void project.usage.sync(project.backend.server, project.life.signal).then(() => { project.value.usage = project.usage.summary(); this.emit(); });
        }
        project.value.usage = project.usage.summary();
        project.value.config = globalSettings ? this.modelSummary(globalSettings) : undefined;
        if (globalSettings) project.io.hide(settingsSecrets(globalSettings));
        if (!(await project.store.exists())) continue;
        const state = await project.store.read();
        const failedTask = state.tasks.filter(task => task.status === "failed" && task.runs.at(-1)?.error).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        project.value.error = state.discoveryPending?.status === "failed" ? state.discoveryPending.error : failedTask ? `任务：${failedTask.title}\n失败原因：${failedTask.runs.at(-1)!.error}\n记录已保留。请先处理具体原因，处理后可输入“继续上次任务”。` : undefined;
        project.value.delivery = state.delivery?.goal === state.project.context.goal ? state.delivery : undefined;
        project.value.awaitingInput = state.awaitingInput ?? (state.tasks.every(task => ["merged", "archived"].includes(task.status)) && state.conversation?.at(-1)?.role === "assistant" && state.conversation.at(-1)?.text.startsWith("目前没有新的可执行建议。"));
        project.value.name = state.project.name; project.value.summary = state.project.context.goal;
        const conversation = state.conversation ?? [];
        // Older records have no boundary: the latest explicit current-goal entry starts their view.
        const startedAt = state.conversationStartedAt ?? conversation.findLast(message => message.role === "user" && message.text === state.project.context.goal)?.at;
        project.history = conversation.flatMap((message, index) => message.role === "user" && (!startedAt || message.at >= startedAt) ? [{ id: message.sourceInputID ?? `history:${index}:${message.at}`, role: "user" as const, text: message.text, at: message.at }] : []).slice(-100);
        project.value.tasks = state.tasks.map(task => {
          const run = task.runs.at(-1);
          return { id: task.id, title: task.title, description: task.description, status: task.status, priority: task.priority, acceptanceCriteria: task.acceptanceCriteria, rationale: task.assessment.rationale,
            run: run ? { status: run.status, branch: run.workspace?.branch, sessionId: run.workerSessionId, error: run.error, checks: run.checks.map(check => ({ name: check.name, ok: check.ok })), acceptance: run.acceptance?.summary, acceptanceDetails: run.acceptance?.criteria.map(item => ({ ...item, kind: quantitativePerformanceTarget(item.criterion) ? "measurement" as const : "requirement" as const })) } : undefined };
        });
      }
      this.emit();
    } catch { /* A concurrent atomic state replacement is read on the next tick. */ }
    finally { this.refreshing = false; }
  }
  async project(directory: string, input: { select?: boolean } = {}): Promise<void> {
    if (this.closing) throw new Error("OpenAGI is closing");
    if (!isAbsolute(directory)) throw new Error("Choose an absolute project directory");
    const root = await realpath(directory); if (!(await stat(root)).isDirectory()) throw new Error("Choose a project folder");
    if (this.draining.has(root)) throw new Error("This project's previous flow is still stopping. Open it again after shutdown finishes.");
    let project = this.projects.get(root);
    if (!project) {
      const inputs = new ProjectInputQueue(root); await inputs.load();
      const controller = new AbortController();
      const usage = new UsageTracker(root); await usage.load().catch(() => {});
      project = { id: `openagi:${createHash("sha256").update(root).digest("hex").slice(0, 20)}`, store: new ProjectStore(root), usage, inputs, history: [], life: new AbortController(), controller, io: new BrowserConversation(controller.signal, inputs), value: { directory: root, name: basename(root), phase: "idle", tasks: [], messages: [], usage: usage.summary() } };
      this.projects.set(root, project); this.emit();
    }
    if (input.select !== false) this.selectedProject = root;
    try { await this.ensureBackend(project); }
    catch (error) { project.io.write(error instanceof Error ? error.message : "Configure OpenAGI models first"); }
    await this.refresh();
  }
  private async require(directory: string): Promise<Project> {
    const root = await realpath(directory); const project = this.projects.get(root);
    if (!project) throw new Error("Open the project using the native OpenAGI project picker first");
    return project;
  }
  private session(project: Project): OpenCodeOptions["onSession"] {
    return session => {
      if (project.life.signal.aborted || this.projects.get(project.value.directory) !== project) return;
      const event: NativeSession = { ...session, mainSessionId: project.value.mainSessionId, directory: project.value.directory, serverId: project.id, focus: false, outcome: "running" };
      this.sessions.delete(`${project.id}:${session.sessionId}`);
      this.sessions.set(`${project.id}:${session.sessionId}`, event); this.emit(); this.sessionListeners.forEach(listener => listener(event));
    };
  }
  private settleModule(project: Project, sessionId: string | undefined, outcome: NativeSession["outcome"], purpose?: string): void {
    if (!sessionId) return;
    const key = `${project.id}:${sessionId}`, current = this.sessions.get(key);
    if (!current) return;
    this.sessions.set(key, { ...current, purpose: purpose ?? current.purpose, outcome }); this.emit();
  }
  private focusWorkflow(project: Project, focus: boolean): void {
    const sessionId = project.value.mainSessionId;
    if (!sessionId || project.life.signal.aborted) return;
    const event: NativeSession = { serverId: project.id, directory: project.value.directory, sessionId, mainSessionId: sessionId, mode: "workflow", label: `OpenAGI · ${project.value.name}`, focus };
    this.sessions.set(`${project.id}:${sessionId}`, event); this.emit(); this.sessionListeners.forEach(listener => listener(event));
  }
  private async ensureWorkflow(project: Project): Promise<void> {
    const server = project.backend!.server;
    const runtime = new OpenCodeRuntime({ baseUrl: server.url, username: "opencode", password: server.password, workspaceRoot: project.value.directory, signal: project.life.signal });
    const file = await withinProject(project.value.directory, ".openagi/native-workflow.json");
    let saved: z.infer<typeof WorkflowView> | undefined;
    try { saved = WorkflowView.parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error; }
    const sessionId = await runtime.workflowSession(project.value.directory, `OpenAGI · ${project.value.name}`, saved?.directory === project.value.directory ? saved.sessionId : undefined);
    project.life.signal.throwIfAborted();
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, directory: project.value.directory, sessionId }), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    project.value.mainSessionId = sessionId;
    this.focusWorkflow(project, false);
    await this.rememberSessions([...this.sessions.values()].filter(item => item.serverId === project.id && item.mode !== "workflow"));
  }
  private async nativeCLI(project: Project) {
    if (!this.input.cli || !isAbsolute(this.input.cli)) return undefined;
    const bin = join(project.value.directory, ".openagi", "runtime", "bin"); await mkdir(bin, { recursive: true });
    const destination = join(bin, "opencode-cli");
    const source = await stat(this.input.cli);
    const metadata = `${source.size}:${source.mtimeMs}`; const version = `${destination}.source`;
    let matches = false; try { matches = (await readFile(version, "utf8")) === metadata; } catch { /* First project launch. */ }
    if (!matches) { await copyFile(this.input.cli, destination, constants.COPYFILE_FICLONE); await writeFile(version, metadata, { mode: 0o600 }); }
    return destination;
  }
  private async ensureBackend(project: Project): Promise<void> {
    project.life.signal.throwIfAborted();
    // An in-flight turn keeps its model snapshot; external CLI edits apply at
    // the next explicit start rather than interrupting a running project.
    if (project.backend && project.operation && project.value.phase !== "configuring" && project.value.mainSessionId && project.configurationSignature) return;
    return project.opening ??= (async () => {
      const loaded = await loadSettings(project.value.directory); project.loaded = loaded;
      const previous = project.backend;
      const signature = JSON.stringify({ loaded, network: this.network });
      if (previous && project.configurationSignature === signature) return;
      if (previous) { await previous.server.close(); project.backend = undefined; }
      project.io.hide(settingsSecrets(loaded));
      project.value.config = this.modelSummary(loaded);
      const backend = await configuredBackend(project.value.directory, loaded, { signal: project.life.signal, nativeInteractions: true, onSession: this.session(project), executable: await this.nativeCLI(project), onProgress: message => project.io.write(message), usage: project.usage });
      if (project.life.signal.aborted) { await backend.server.close(); return; }
      project.backend = backend;
      try { await this.ensureWorkflow(project); }
      catch (error) { await backend.server.close(); project.backend = undefined; project.configurationSignature = undefined; throw error; }
      project.configurationSignature = signature; this.emit();
    })().finally(() => { project.opening = undefined; });
  }
  private async begin(directory: string, mode: "run" | "config", input: { summary?: string; resume?: boolean } = {}) {
    const project = await this.require(directory);
    if (this.editing) throw new Error("全局配置正在保存，请完成后再开始任务。");
    if (project.operation || project.stopping) throw new Error("Pause the current OpenAGI flow before starting another");
    if (mode === "config" && [...this.projects.values()].some(item => item.operation || item.stopping)) throw new Error("请先暂停正在运行的项目，再更改全局模型配置。");
    if (mode === "run" && [...this.projects.values()].some(item => item.value.phase === "configuring")) throw new Error("请先完成或取消全局模型配置。");
    await project.inputs.load();
    project.controller = new AbortController(); project.io.close(); project.inputEpoch = new Date().toISOString(); project.io = new BrowserConversation(project.controller.signal, mode === "run" ? project.inputs : undefined);
    project.value.phase = mode === "run" ? "running" : "configuring"; this.emit();
    project.operation = (async () => {
      try {
        if (mode === "config") {
          const file = await configurationWizard(project.value.directory, project.io, undefined, { signal: project.controller.signal });
          if (file && !project.controller.signal.aborted) {
            for (const item of this.projects.values()) { project.controller.signal.throwIfAborted(); await this.ensureBackend(item); }
          }
          return;
        }
        await this.ensureBackend(project); project.controller.signal.throwIfAborted();
        this.focusWorkflow(project, true);
        const loaded = project.loaded!; const server = project.backend!.server;
        project.io.hide(settingsSecrets(loaded));
        let summary = input.summary?.trim(); if (input.resume) summary = (await project.store.read()).project.context.goal;
        if (!summary) throw new Error("Describe this project's goal or explicitly choose resume");
        const delegate = new OpenCodeRuntime({ baseUrl: server.url, username: "opencode", password: server.password, workspaceRoot: project.value.directory, timeoutMs: 900_000, signal: project.controller.signal, nativeInteractions: true, onSession: this.session(project), workflow: { mainSessionId: project.value.mainSessionId!, directory: project.value.directory } });
        const configured = new ConfiguredRuntime(delegate, loaded, project.value.directory, project.controller.signal, undefined, stage => { project.io.activity(stage); this.emit(); }, { tracker: project.usage });
        const runtime: AgentRuntime = {
          run: async request => {
            try { const reply = await configured.run(request); this.settleModule(project, reply.sessionId, "succeeded", request.purpose); return reply; }
            catch (error) { const captured = error as { sessionId?: string; rawReply?: { sessionId: string } }; this.settleModule(project, captured.sessionId ?? captured.rawReply?.sessionId, project.controller.signal.aborted || (error as { kind?: string }).kind === "interrupted" ? "interrupted" : "failed", request.purpose); throw error; }
          },
          search: request => configured.search(request),
        };
        const session = new InteractiveSession(project.store, runtime, project.io, project.controller.signal, { autoProceed: true });
        if (!(await session.initialize({ summary }))) return;
        await this.refresh();
        await project.store.withLock(async () => { const state = await project.store.read(); applySettings(state.project, loaded); await project.store.write(state); });
        session.setIsolation(project.backend!.isolation); await session.run();
      } catch (error) { if (!project.controller.signal.aborted) { const message = error instanceof Error ? error.message : "OpenAGI flow failed"; project.io.error(message); project.io.write(message); } }
      finally { project.io.close(); project.value.phase = "idle"; project.operation = undefined; await this.refresh(); }
    })();
  }
  async run(directory: string, input: { summary?: string; resume?: boolean }) { await this.begin(directory, "run", input); }
  private modelSummary(loaded: LoadedSettings) { return { heavy: `${loaded.settings.models.heavy.providerID}/${loaded.settings.models.heavy.modelID}`, light: `${loaded.settings.models.light.providerID}/${loaded.settings.models.light.modelID}` }; }
  async config(directory: string) {
    const project = await this.require(directory);
    if (project.io.failure && project.operation) { await this.pause(directory); await project.stopping; }
    await this.begin(directory, "config");
  }
  async answer(directory: string, id: string, text: string) { const project = await this.require(directory); project.io.answer(id, text); this.emit(); }
  async submit(directory: string, text: string): Promise<void> {
    const project = await this.require(directory);
    const input = text.trim();
    if (!input) return;
    if (["退出", "暂停", "exit", "quit", "/exit", "/quit", "/退出", "/暂停"].includes(input.toLowerCase())) { await this.pause(directory); return; }
    if (project.io.prompt) { project.io.answer(project.io.prompt.id, input); this.emit(); return; }
    if (project.operation) { if (project.value.phase === "configuring") await project.inputs.enqueue(input); else await project.io.enqueue(input); this.emit(); return; }
    if (["继续", "继续上次项目", "继续上次任务", "resume", "/resume"].includes(input.toLowerCase())) { await this.run(directory, { resume: true }); return; }
    await this.run(directory, { summary: input });
  }
  async pause(directory: string) {
    const project = await this.require(directory); if (!project.operation) return;
    project.value.phase = "stopping"; project.controller.abort(); project.io.close(); this.emit();
    project.stopping ??= project.operation.finally(() => { project.stopping = undefined; });
  }
  async forget(directory: string): Promise<void> {
    const root = await realpath(directory); const project = this.projects.get(root);
    if (!project) return;
    project.controller.abort(); project.io.close();
    this.projects.delete(root);
    if (this.selectedProject === root) this.selectedProject = [...this.projects.keys()].at(-1);
    for (const [id, session] of this.sessions) if (session.serverId === project.id) this.sessions.delete(id);
    // Forgetting a native server removes only in-memory ownership. Keep a
    // guard until old writes drain, so reopening cannot start a second writer.
    const shutdown = this.retire(project);
    const drained = Promise.allSettled([shutdown, project.opening, project.operation]).then(() => {}).finally(() => { this.draining.delete(root); });
    this.draining.set(root, drained); this.emit();
    await shutdown;
  }
  private async retire(project: Project): Promise<void> {
    project.controller.abort(); project.io.close();
    // The adapter's user interrupt commits a terminal only after its native
    // idle boundary. Let it settle before stopping the owned transport.
    if (project.operation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([project.operation.catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 6_000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    project.life.abort(); await project.backend?.server.close();
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.timer);
      await Promise.allSettled([...this.projects.values()].map(project => this.retire(project)));
      this.listeners.clear(); this.sessionListeners.clear();
    })();
  }
}
