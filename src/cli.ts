#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Check, ProjectConfig, moduleNames, type Task } from "./domain.js";
import { ProjectStore } from "./store.js";
import { OpenAGI } from "./engine.js";
import { inferredChecks, parseModel, type RunProjectOptions } from "./project.js";
import { InteractiveSession } from "./session.js";
import { terminalIO } from "./terminal.js";
import { answerOpenCode, SessionStopped } from "./interactions.js";
import type { AgentRuntime } from "./runtime.js";
import type { ManagedServer } from "./server.js";
import { applySettings, createSettingsTemplate, loadSettings, settingsSummary } from "./settings.js";
import { configuredBackend } from "./backend.js";
import { withinProject } from "./boundary.js";
import { ConfiguredRuntime } from "./configured-runtime.js";
import { configurationWizard } from "./config-wizard.js";
import { launchDesktop } from "./desktop/launcher.js";
import { loadNetworkProfile } from "./network-profile.js";

const help = `OpenAGI — Tutor → selected task → OpenCode v2 Worker → Validator

Usage: openagi <command> [arguments] [--path /repo] [--json]
  run [SUMMARY]            打开 OpenAGI 桌面 App；等待你开始项目或继续已有记录
  desktop [SUMMARY]        同 run，打开桌面 App
  run --cli [SUMMARY]      使用终端持续交互入口
  config                   交互配置 provider、Heavy/Light 模型与固定 TypeSafe Jev 密钥
  config init              仅生成配置模板
  init                     Initialize project, modules, goals and checks
  configure --config FILE  Replace project configuration (preserves tasks/history)
  tutor                    Run enabled discovery modules in parallel and collect proposals
  list [--all]             List tasks ordered by priority; --all includes archives/completed
  show TASK                Show task, questions, scores, research and execution history
  answer TASK QUESTION ANSWER  Record a decision; Collector refines when all are answered
  interview TASK           Answer unresolved questions interactively
  reevaluate TASK          Reassess an archived/ready task with current context
  work TASK [--retry]       Research, implement in Worktree and validate
  resume TASK              Continue interrupted execution in its existing Worktree/session
  validate TASK            Recheck a completed Worker run after manual fixes
  rebase TASK              Update a completed branch onto the current base and revalidate
  merge TASK               Fast-forward the exact validated commit into unchanged base

Init options:
  --summary TEXT           Project summary for run (otherwise prompted once)
  --modules function-finder,performance-optimizer,ui-designer
  --name NAME --goal TEXT [--audience TEXT] [--constraints TEXT]
  模型、提供方地址和密钥统一使用 OpenAGI 根目录的 .openagi/config.json。
  --checks FILE            JSON array of {name,command,args,timeoutMs}; scripts auto-detected
  --no-checks              Explicitly waive configured checks (independent acceptance stays)
  --config FILE            OpenAGI model/provider/Jev config (default OpenAGI root/.openagi/config.json)
  --project-config FILE    Project metadata/checks JSON for init/run

模型及 Jev 来源由 OpenAGI 根目录的全局配置控制，不继承 OpenCode 的模型或凭据。
`;

function findTask(tasks: Task[], id: string | undefined): Task {
  if (!id) throw new Error("A task ID is required");
  const matches = tasks.filter(task => task.id === id || task.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? "Task ID is ambiguous" : `Task not found: ${id}`);
  return matches[0]!;
}

function taskDescription(task: Task) {
  const a = task.assessment;
  return [
    `${task.id}  ${task.status}  priority ${task.priority}/100  ${task.title}`,
    task.description,
    `Modules: ${task.modules.join(", ")}`,
    `Necessity ${a.necessity}, Value ${a.value}, Urgency ${a.urgency}, Feasibility ${a.feasibility}, Clarity ${a.requirementClarity} (0–5); User decision: ${a.userDecisionRequired}`,
    `Reason: ${a.rationale}`,
    ...task.evidence.map(evidence => `Evidence: ${evidence.location} — ${evidence.observation}`),
    ...task.acceptanceCriteria.map(criterion => `Acceptance: ${criterion}`),
    ...task.questions.map(question => `Question ${question.id}: ${question.question}${question.answer ? `\n  Answer: ${question.answer}` : ""}`),
    ...(a.archiveReason ? [`Archived: ${a.archiveReason}`, ...a.reevaluateWhen.map(condition => `Reevaluate when: ${condition}`)] : []),
    ...task.runs.flatMap(run => [
      `Run ${run.id}: ${run.status}${run.workspace ? `\n  Worktree: ${run.workspace.directory}\n  Branch: ${run.workspace.branch}` : ""}${run.workerSessionId ? `\n  OpenCode worker session: ${run.workerSessionId}` : ""}${run.validatedHead ? `\n  Validated commit: ${run.validatedHead}` : ""}${run.error ? `\n  Error: ${run.error}` : ""}`,
      ...(run.guidance ? [`Guidance: ${run.guidance.summary}`, `Approach: ${run.guidance.approach}`, ...run.guidance.integrationSteps.map(step => `Integration: ${step}`), ...run.guidance.validationPlan.map(step => `Validation plan: ${step}`)] : []),
      ...run.sources.map(source => `Source: ${source.title} (${source.url})`),
      ...run.searchErrors.map(error => `Search failure: ${error}`),
      ...run.checks.map(check => `Check ${check.name}: ${check.ok ? "PASS" : "FAIL"}${check.timedOut ? " (timeout)" : ""}${check.ok ? "" : `\n${check.stdout}\n${check.stderr}`}`),
      ...(run.acceptance?.criteria.map(item => `Acceptance ${item.passed ? "PASS" : "FAIL"}: ${item.criterion}\n  Evidence: ${item.evidence}`) ?? []),
    ]),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    path: { type: "string" }, summary: { type: "string" }, modules: { type: "string" }, name: { type: "string" }, goal: { type: "string" },
    audience: { type: "string" }, constraints: { type: "string" }, "opencode-url": { type: "string" },
    model: { type: "string" }, "discovery-model": { type: "string" }, "collector-model": { type: "string" },
    "guider-model": { type: "string" }, "worker-model": { type: "string" }, "validator-model": { type: "string" },
    config: { type: "string" }, "project-config": { type: "string" }, checks: { type: "string" }, "no-checks": { type: "boolean" },
    json: { type: "boolean" }, all: { type: "boolean" }, retry: { type: "boolean" }, help: { type: "boolean", short: "h" },
    cli: { type: "boolean" }, "no-open": { type: "boolean" }, port: { type: "string" },
  } });
  const [requestedCommand, id, questionId, answer] = positionals;
  const command = requestedCommand ?? "run";
  if (command === "help" || values.help) { console.log(help); return; }
  const directory = await realpath(await withinProject(process.cwd(), values.path ?? "."));
  const store = new ProjectStore(directory);
  const print = (value: unknown, readable: string) => console.log(values.json ? JSON.stringify(value, null, 2) : readable);
  if (command === "desktop" || (command === "run" && !values.cli)) {
    if (values.json) throw new Error("桌面入口不支持 --json");
    await launchDesktop(directory, values.summary ?? values.goal ?? (positionals.slice(1).join(" ") || undefined));
    console.log(`已打开 OpenAGI 桌面 App\n当前项目：${directory}\n窗口会等待你的指令，不会自动继续上次任务。`); return;
  }
  await loadNetworkProfile();
  if (command === "config") {
    if (id === "init") { const file = await createSettingsTemplate(directory, values.config); console.log(`已生成配置：${file}\n也可运行 openagi config 交互填写。`); return; }
    if (id) throw new Error("Usage: openagi config [init]");
    const controller = new AbortController(); const stop = () => controller.abort();
    const io = terminalIO(controller.signal, stop); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    try { await configurationWizard(directory, io, values.config, { signal: controller.signal }); }
    finally { io.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  if (command === "run") {
    if (values.json) throw new Error("run uses an interactive conversation; --json is available on the single-step commands");
    if (values.checks && values["no-checks"]) throw new Error("Choose --checks or --no-checks");
    const controller = new AbortController();
    const stop = () => controller.abort();
    const io = terminalIO(controller.signal, stop);
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    let runtime: ConfiguredRuntime;
    const proxy: AgentRuntime = { run: request => runtime.run(request), search: request => runtime.search(request) };
    const session = new InteractiveSession(store, proxy, io, controller.signal);
    let managedServer: ManagedServer | undefined;
    try {
      if (values["opencode-url"]) throw new Error("run 使用当前项目的隔离后端。模型 API 地址请填写在 OpenAGI 配置的 providers.*.baseURL 中。");
      if (values.model || ["discovery", "collector", "guider", "worker", "validator"].some(role => values[`${role}-model` as keyof typeof values])) throw new Error("请在 OpenAGI 配置的 models 和 jev 字段中选择模型，运行时不会继承或覆盖为 OpenCode 设置。");
      const loaded = await loadSettings(directory, values.config);
      io.write(settingsSummary(loaded));
      const options: RunProjectOptions = {
        summary: values.summary ?? values.goal ?? (positionals.slice(1).join(" ") || undefined),
        name: values.name, modules: values.modules, audience: values.audience, constraints: values.constraints,
        opencodeUrl: values["opencode-url"], model: values.model,
        roleModels: Object.fromEntries(["discovery", "collector", "guider", "worker", "validator"].map(role => [role, values[`${role}-model` as keyof typeof values]])),
        checks: values.checks ? z.array(Check).parse(JSON.parse(await readFile(await withinProject(directory, values.checks), "utf8"))) : undefined,
        noChecks: values["no-checks"], config: values["project-config"] ? JSON.parse(await readFile(await withinProject(directory, values["project-config"]), "utf8")) : undefined,
      };
      if (!(await session.initialize(options)) || controller.signal.aborted) return;
      await store.withLock(async () => { const state = await store.read(); applySettings(state.project, loaded); await store.write(state); });
      io.write("正在启动当前项目的隔离 OpenCode 执行后端…");
      const backend = await configuredBackend(directory, loaded, { signal: controller.signal, onProgress: message => io.write(message), onInteraction: async pending => {
        try { return await answerOpenCode(io, pending); } catch (error) { if (error instanceof SessionStopped) stop(); throw error; }
      } });
      runtime = backend.runtime; managedServer = backend.server;
      session.setIsolation(backend.isolation);
      if (!controller.signal.aborted) await session.run();
    } catch (error) { if (!controller.signal.aborted) throw error; }
    finally { await managedServer?.close(); io.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
    return;
  }
  if (command === "init") {
    if (values.checks && values["no-checks"]) throw new Error("Choose --checks or --no-checks");
    const metadataFile = values["project-config"] ?? values.config;
    const input: Record<string, unknown> = metadataFile ? JSON.parse(await readFile(await withinProject(directory, metadataFile), "utf8")) : {};
    if (!metadataFile) {
      let modules = values.modules; let goal = values.goal;
      if ((!modules || !goal) && process.stdin.isTTY) {
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
          modules ??= (await terminal.question(`Enable modules (${moduleNames.join(",")}): `)).trim();
          goal ??= (await terminal.question("What is this project's next product goal? ")).trim();
        } finally { terminal.close(); }
      }
      if (!modules || !goal) throw new Error("Init requires --modules and --goal, or --config (interactive when stdin is a terminal)");
      const fallback = parseModel(values.model);
      Object.assign(input, {
        name: values.name ?? directory.split("/").at(-1), modules: modules.split(",").map(module => module.trim()),
        context: { goal, audience: values.audience, constraints: values.constraints },
        opencode: { url: values["opencode-url"] },
        models: Object.fromEntries(["discovery", "collector", "guider", "worker", "validator"].map(role => [role, parseModel(values[`${role}-model` as keyof typeof values] as string | undefined) ?? fallback])),
        validation: { checks: values.checks ? z.array(Check).parse(JSON.parse(await readFile(await withinProject(directory, values.checks), "utf8"))) : await inferredChecks(directory), requireChecks: !values["no-checks"] },
      });
    }
    const project = ProjectConfig.parse({ ...input, directory });
    const state = { version: 1 as const, project, tasks: [], discoveryErrors: [] };
    await store.withLock(async () => {
      if (await store.exists()) throw new Error("Project already initialized; use configure to preserve task history");
      await store.write(state);
    });
    print(state, `Initialized ${project.name}\nModules: ${project.modules.join(", ")}\nValidation checks: ${project.validation.checks.map(check => check.name).join(", ") || "none — configure checks before work, or explicitly use --no-checks"}\nConfig/state: ${store.file}\nNext: openagi tutor --path ${directory}`);
    return;
  }
  if (!(await store.exists())) throw new Error("Project not initialized; run openagi init first");
  if (command === "configure") {
    if (!values.config) throw new Error("Configure requires --config FILE with a complete project configuration");
    const project = ProjectConfig.parse({ ...JSON.parse(await readFile(await withinProject(directory, values.config), "utf8")), directory });
    await store.withLock(async () => {
      const state = await store.read();
      if (state.tasks.some(task => task.status === "running")) throw new Error("Resume or finish interrupted runs before changing project configuration");
      state.project = project; await store.write(state);
    });
    print(project, "Project configuration updated; task history preserved"); return;
  }
  const state = await store.read();
  if (command === "list") {
    const tasks = state.tasks.filter(task => values.all || !["archived", "merged"].includes(task.status)).sort((a, b) => b.priority - a.priority);
    print(tasks, tasks.map(task => `${task.id.slice(0, 8)}  ${task.status.padEnd(13)}  ${String(task.priority).padStart(3)}/100  ${task.title}`).join("\n") || "No tasks yet; run tutor"); return;
  }
  if (command === "show") { const task = findTask(state.tasks, id); print(task, taskDescription(task)); return; }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  let backend: Awaited<ReturnType<typeof configuredBackend>> | undefined;
  try {
    const loaded = await loadSettings(directory, values.config);
    await store.withLock(async () => { const latest = await store.read(); applySettings(latest.project, loaded); await store.write(latest); });
    console.error(settingsSummary(loaded));
    backend = await configuredBackend(directory, loaded, { signal: controller.signal, onProgress: message => console.error(message) });
    const engine = new OpenAGI(store, backend.runtime, message => console.error(message), controller.signal, backend.isolation);
    if (command === "tutor") {
      const result = await engine.discover();
      print(result, `${result.tasks.length} tasks retained\n${result.tasks.filter(task => task.status !== "merged").sort((a, b) => b.priority - a.priority).map(task => `${task.id.slice(0, 8)}  ${task.status}  ${task.priority}/100  ${task.title}`).join("\n")}${result.discoveryErrors.length ? `\nModule failures:\n${result.discoveryErrors.map(error => `${error.module}: ${error.message}`).join("\n")}` : ""}`);
      if (result.discoveryErrors.length === result.project.modules.length) process.exitCode = 1;
      return;
    }
    if (!id) throw new Error("A task ID is required");
    let result: Task;
    switch (command) {
      case "answer":
        if (!questionId || !answer || positionals.length !== 4) throw new Error('Usage: openagi answer TASK QUESTION "your answer"');
        result = await engine.answer(id, questionId, answer); break;
      case "interview": {
        if (!process.stdin.isTTY) throw new Error("Interview requires a terminal; use answer for scripted input");
        const terminal = createInterface({ input: process.stdin, output: process.stdout });
        try {
          result = findTask(state.tasks, id);
          while (result.status === "awaiting_user") {
            const question = result.questions.find(item => !item.answer);
            if (!question) break;
            const response = await terminal.question(`${question.question}\n> `);
            result = await engine.answer(id, question.id, response);
          }
        } finally { terminal.close(); }
        break;
      }
      case "reevaluate": result = await engine.reevaluate(id); break;
      case "work": result = await engine.execute(id, { retry: values.retry }); break;
      case "resume": result = await engine.execute(id, { resume: true }); break;
      case "validate": result = await engine.validate(id); break;
      case "rebase": result = await engine.rebase(id); break;
      case "merge": result = await engine.merge(id); break;
      default: throw new Error(`Unknown command: ${command}; use --help`);
    }
    print(result, taskDescription(result));
  } finally { await backend?.server.close(); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

function isEntrypoint(): boolean {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; }
  catch { return false; }
}
if (isEntrypoint()) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
