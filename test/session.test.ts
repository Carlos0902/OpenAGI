import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { OpenCodeError } from "../src/opencode.js";
import { InteractiveSession } from "../src/session.js";
import { ProjectStore } from "../src/store.js";
import { Task, type Proposal } from "../src/domain.js";
import { OpenAGI } from "../src/engine.js";
import type { AgentRequest, AgentRuntime } from "../src/runtime.js";
import type { ConversationIO } from "../src/terminal.js";
import { BrowserConversation } from "../src/conversation.js";
import { ProjectInputQueue } from "../src/input-queue.js";

const execute = promisify(execFile);
const criteria = ["The feature returns after", "A regression test verifies the new behavior"];
const proposal: Proposal = { title: "改善核心功能", description: "让核心功能返回用户期望的结果", evidence: [{ location: "feature.cjs", observation: "Current result is before" }], acceptanceCriteria: criteria, questions: [] };
const assessment = { necessity: 5, value: 4, urgency: 4, feasibility: 5, requirementClarity: 5, userDecisionRequired: false, rationale: "核心用户流程的具体改进", reevaluateWhen: [] };
const guidance = { summary: "复用现有功能", approach: "修改返回值并增加测试", alternatives: [], integrationSteps: ["Update feature.cjs", "Add feature.test.cjs"], risks: [], dependencies: [], validationPlan: ["Run regression tests"] };
const regression = "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('feature behavior',()=>assert.equal(require('./feature.cjs')(),'after'));\n";

class ScriptIO implements ConversationIO {
  readonly output: string[] = [];
  readonly prompts: string[] = [];
  constructor(private answers: (string | null)[]) {}
  write(message: string) { this.output.push(message); }
  async ask(prompt: string) { this.prompts.push(prompt); return this.answers.shift() ?? null; }
}

class QueuedIO extends ScriptIO {
  private input: string[] = [];
  enqueue(text: string) { this.input.push(text); }
  takeInput() { return this.input.shift(); }
}

class Runtime implements AgentRuntime {
  readonly requests: AgentRequest[] = [];
  builds = 0;
  discoveryCount = 0;
  question = false;
  failFirstBuild = false;
  pendingFirstBuild = false;
  naturalTaskId?: string;
  malformedAdvice = false;
  failCollector = false;
  async search() { return []; }
  async run(request: AgentRequest) {
    this.requests.push(request);
    let value: unknown;
    if (request.prompt.includes("conversational project tutor")) value = { reply: "可以优先解决这个问题。", action: "choose", taskId: this.naturalTaskId ?? "invented-task", updateContext: true };
    else if (request.prompt.includes("Design executable")) value = { explanation: "通过 Node 回归测试验证行为。", checks: [{ name: "behavior", command: process.execPath, args: ["--test", "feature.test.cjs"], timeoutMs: 5_000 }] };
    else if (request.mode === "observe") {
      this.discoveryCount++;
      value = { proposals: request.prompt.includes("function-finder") ? [{ ...proposal, questions: this.question ? [{ id: "audience", question: "这项功能主要服务谁？" }] : [] }] : [] };
    } else if (request.prompt.includes("independent Collector")) {
      const candidates = JSON.parse(request.prompt.split("\nCandidates: ")[1]!.split("\n")[0]!) as { id: string; proposal: Proposal }[];
      value = { groups: candidates.map(candidate => {
        const unresolved = candidate.proposal.questions.some(question => !question.answer);
        return { candidateIds: [candidate.id], proposal: candidate.proposal, assessment: { ...assessment, userDecisionRequired: unresolved, requirementClarity: unresolved ? 2 : 5 } };
      }) };
    } else if (request.mode === "research") value = guidance;
    else if (request.mode === "build") {
      this.builds++;
      if (this.pendingFirstBuild && this.builds === 1) throw Object.assign(new Error("等待上游授权"), { sessionId: "ses_saved" });
      await writeFile(join(request.directory, "feature.cjs"), `module.exports = () => '${this.failFirstBuild && this.builds === 1 ? "wrong" : "after"}';\n`);
      await writeFile(join(request.directory, "feature.test.cjs"), regression);
      return { sessionId: "ses_saved", text: "Implemented" };
    } else value = { criteria: criteria.map(criterion => ({ criterion, passed: true, evidence: "feature.cjs 和真实回归测试验证了该项行为" })), summary: "两项验收条件都已满足。" };
    if (this.failCollector && request.prompt.includes("independent Collector")) value = { groups: [] };
    return { sessionId: `ses_${this.requests.length}`, text: JSON.stringify(value) };
  }
}

async function fixture(t: { after(fn: () => Promise<void>): void }, ioAnswers: (string | null)[]) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await execute("git", ["-C", directory, ...args])).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Session Test"); await git("config", "user.email", "session@example.invalid"); await git("config", "commit.gpgsign", "false");
  await writeFile(join(directory, ".gitignore"), ".openagi/\n");
  await writeFile(join(directory, "feature.cjs"), "module.exports = () => 'before';\n");
  await git("add", "."); await git("commit", "-m", "initial");
  const base = await git("rev-parse", "HEAD");
  const store = new ProjectStore(directory); const runtime = new Runtime(); const io = new ScriptIO(ioAnswers);
  const session = new InteractiveSession(store, runtime, io);
  return { directory, git, base, store, runtime, io, session };
}

async function freshNestedFixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = await fixture(t, []);
  const directory = join(parent.directory, "new-project");
  await mkdir(directory);
  await appendFile(join(parent.directory, ".git", "info", "exclude"), "\n/new-project/\n");
  const git = async (...args: string[]) => (await execute("git", ["-C", directory, ...args])).stdout.trim();
  return { parent, directory, git, store: new ProjectStore(directory), runtime: new Runtime() };
}

test("one summary starts all modules, asks missing decisions, executes, accepts and merges in the same conversation", async t => {
  const f = await fixture(t, ["个人开发者的效率工具，希望改善核心流程", "个人开发者", "", "退出"]);
  f.runtime.question = true;
  assert(await f.session.initialize({ checks: [{ name: "tests", command: process.execPath, args: ["--test", "feature.test.cjs"], timeoutMs: 5_000 }] }));
  await f.session.run();
  const state = await f.store.read();
  assert.deepEqual(state.project.modules, ["function-finder", "performance-optimizer", "ui-designer"]);
  assert.equal(state.tasks[0]?.status, "merged");
  assert.equal(state.tasks[0]?.questions[0]?.answer, "个人开发者");
  assert.equal(f.runtime.discoveryCount, 6, "all modules run again automatically after merging");
  assert.equal(f.runtime.builds, 1);
  assert.notEqual(await f.git("rev-parse", "HEAD"), f.base);
  assert.match(await readFile(join(f.directory, "feature.cjs"), "utf8"), /after/);
  assert(state.conversation?.some(message => message.text.includes("已完成并合并")));
  assert(f.io.output.some(text => text.includes("验收通过")));
});

test("failed acceptance is fed back to Worker once and rechecked before any merge", async t => {
  const f = await fixture(t, ["", "退出"]);
  f.runtime.failFirstBuild = true;
  await f.session.initialize({ summary: "完善现有功能", checks: [{ name: "tests", command: process.execPath, args: ["--test", "feature.test.cjs"], timeoutMs: 5_000 }] });
  await f.session.run();
  assert.equal(f.runtime.builds, 2);
  assert.equal((await f.store.read()).tasks[0]?.status, "merged");
  const repair = f.runtime.requests.filter(request => request.mode === "build")[1]!;
  assert.match(repair.prompt, /Independent validation rejected/);
  assert.match(repair.prompt, /Check evidence/);
  assert.match(repair.prompt, /do not weaken or bypass/);
});

test("relaunch resumes saved Worker state only after an explicit startup choice", async t => {
  const f = await fixture(t, ["", "退出"]);
  f.runtime.pendingFirstBuild = true;
  await f.session.initialize({ summary: "完善现有功能", checks: [{ name: "tests", command: process.execPath, args: ["--test", "feature.test.cjs"], timeoutMs: 5_000 }] });
  await f.session.run();
  const saved = (await f.store.read()).tasks[0]!.runs[0]!;
  assert.equal(saved.workerSessionId, "ses_saved");
  const io = new ScriptIO(["1", "", "退出"]);
  const next = new InteractiveSession(f.store, f.runtime, io);
  await next.initialize(); await next.run();
  const state = await f.store.read();
  assert.equal(state.tasks[0]?.status, "merged");
  assert.equal(state.tasks[0]?.runs[0]?.workspace?.directory, saved.workspace?.directory);
  assert.equal(f.runtime.requests.filter(request => request.mode === "research").length, 1);
  assert.equal(f.runtime.requests.filter(request => request.mode === "build")[1]?.sessionId, "ses_saved");
  assert(!io.prompts.some(prompt => prompt.includes("说明项目")));
  assert(io.prompts[0]?.includes("本次想做什么"));
});

test("a task can be deferred while answering requirements, retaining its reason and future reevaluation condition", async t => {
  const f = await fixture(t, ["跳过", "退出"]); f.runtime.question = true;
  await f.session.initialize({ summary: "优化项目" }); await f.session.run();
  const task = (await f.store.read()).tasks[0]!;
  assert.equal(task.status, "archived"); assert.match(task.assessment.archiveReason!, /暂缓/);
  assert(task.assessment.reevaluateWhen.length); assert.equal(f.runtime.builds, 0);
  assert.equal(await f.git("rev-parse", "HEAD"), f.base);
});

test("missing checks are planned and confirmed inside the conversation without a separate configuration command", async t => {
  const f = await fixture(t, ["", "", "退出"]);
  await f.session.initialize({ summary: "完善功能" }); await f.session.run();
  const state = await f.store.read();
  assert.equal(state.project.validation.checks[0]?.name, "behavior");
  assert.equal(state.tasks[0]?.status, "merged");
  assert(f.io.prompts.some(prompt => prompt.includes("测试方案")));
});

test("natural-language preferences select a known task and are saved as context before execution", async t => {
  const f = await fixture(t, ["优先解决第二个问题", "退出"]);
  await f.session.initialize({ summary: "优化项目" });
  await f.store.withLock(async () => {
    const state = await f.store.read(); const now = new Date().toISOString();
    state.tasks = ["first", "second"].map((id, index) => Task.parse({ ...proposal, id, title: index ? "第二个问题" : "第一个问题", modules: ["function-finder"], status: "ready", assessment, priority: 90 - index, createdAt: now, updatedAt: now, runs: [] }));
    await f.store.write(state);
  });
  f.runtime.naturalTaskId = "second";
  await f.session.run();
  assert((await f.store.read()).project.context.notes?.includes("优先解决第二个问题"));
  assert(f.io.output.some(text => text.includes("建议下一步：第二个问题")));
  assert.equal(f.runtime.builds, 0);
});

test("EOF pauses without executing a proposed task and configuration can be adjusted on the next run", async t => {
  const f = await fixture(t, [null]);
  await f.session.initialize({ summary: "优化项目" }); await f.session.run();
  assert.equal(f.runtime.builds, 0); assert.equal((await f.store.read()).tasks[0]?.status, "ready");
  const next = new InteractiveSession(f.store, f.runtime, new ScriptIO(["1"]));
  await next.initialize({ model: "test/new-model", modules: "performance-optimizer" });
  const state = await f.store.read();
  assert.equal(state.project.models.worker?.modelID, "new-model");
  assert.deepEqual(state.project.modules, ["performance-optimizer"]);
  assert.equal(state.tasks.length, 1);
});

test("blank summary or EOF before initialization produces no project state", async t => {
  const f = await fixture(t, [null]);
  assert.equal(await f.session.initialize(), false); assert.equal(await f.store.exists(), false);
});

test("startup waits for input; Enter, exit and EOF keep saved state unchanged and make no model calls", async t => {
  const f = await fixture(t, []); await f.session.initialize({ summary: "上次的贪吃蛇" });
  const original = await readFile(f.store.file, "utf8");
  for (const answer of ["", "退出", null]) {
    const next = new InteractiveSession(f.store, f.runtime, new ScriptIO([answer]));
    assert.equal(await next.initialize(), false);
    assert.equal(await readFile(f.store.file, "utf8"), original);
    assert.equal(f.runtime.requests.length, 0);
  }
  let resolveInput!: (answer: string) => void;
  const io: ConversationIO = { write() {}, ask: () => new Promise<string>(resolve => { resolveInput = resolve; }) };
  const next = new InteractiveSession(f.store, f.runtime, io); const pending = next.initialize();
  while (!resolveInput) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.runtime.requests.length, 0); assert.equal(await readFile(f.store.file, "utf8"), original);
  resolveInput("1"); assert.equal(await pending, true); assert.equal(f.runtime.requests.length, 0);
});

test("resuming an old awaiting-user task reassesses legacy questions without asking an optional learning question", async t => {
  const f = await fixture(t, ["退出"]); await f.session.initialize({ summary: "浏览器贪吃蛇" });
  await f.store.withLock(async () => {
    const state = await f.store.read(); const now = new Date().toISOString();
    state.tasks = [Task.parse({ ...proposal, id: "saved-game", modules: ["function-finder"], questions: [{ id: "learning", question: "是否为了学习编程？" }], status: "awaiting_user", createdAt: now, updatedAt: now, priority: 80, runs: [], assessment: { ...assessment, userDecisionRequired: true } })];
    await f.store.write(state);
  });
  f.runtime.run = async request => {
    f.runtime.requests.push(request); assert.equal(request.purpose, "collector");
    return { sessionId: "less-interview", text: JSON.stringify({ groups: [{ candidateIds: ["saved-game"], proposal: { ...proposal, questions: [{ id: "learning", question: "是否为了学习编程？", blocking: false }], assumptions: ["先交付可玩的游戏，教学内容作为可选后续。"] }, assessment: { ...assessment, requirementClarity: 2.2 } }] }) };
  };
  await f.session.run();
  const saved = (await f.store.read()).tasks[0]!;
  assert.equal(saved.status, "ready"); assert.equal(saved.questions[0]?.answer, undefined);
  assert(f.io.prompts.every(prompt => !prompt.includes("是否为了学习编程")));
  assert(f.io.output.some(text => text.includes("不需要逐项确认")));
  assert.equal(f.runtime.requests.length, 1); assert.equal(f.runtime.builds, 0);
});

test("answering consecutive blockers does not repeatedly print the same long task description", async t => {
  const f = await fixture(t, ["本机", "电脑浏览器", "退出"]); await f.session.initialize({ summary: "改善功能" });
  await f.store.withLock(async () => {
    const state = await f.store.read(); const now = new Date().toISOString();
    state.tasks = [Task.parse({ ...proposal, id: "two-decisions", modules: ["function-finder"], status: "awaiting_user", assessment: { ...assessment, userDecisionRequired: true }, priority: 80, runs: [], createdAt: now, updatedAt: now,
      questions: [{ id: "where", question: "交付到哪里？" }, { id: "platform", question: "选择哪个核心平台？" }] })];
    await f.store.write(state);
  });
  await f.session.run();
  assert.equal(f.io.prompts.filter(prompt => prompt.includes("交付到哪里")).length, 1);
  assert.equal(f.io.prompts.filter(prompt => prompt.includes("选择哪个核心平台")).length, 1);
  assert.equal(f.io.output.filter(text => text.includes("建议下一步：")).length, 2, "describe once for the interview and once when ready, not after every answer");
  assert.equal(f.runtime.builds, 0);
});

test("a new startup summary archives previous tasks without deleting their saved execution", async t => {
  const f = await fixture(t, ["", "退出"]); f.runtime.pendingFirstBuild = true;
  await f.session.initialize({ summary: "旧项目", noChecks: true }); await f.session.run();
  const before = await f.store.read(); const task = before.tasks[0]!;
  for (const answers of [["2", "", "2", "新的待办应用"], ["直接输入的新目标"]]) {
    const expectedGoal = answers.at(-1);
    const next = new InteractiveSession(f.store, f.runtime, new ScriptIO(answers));
    const calls = f.runtime.requests.length; assert(await next.initialize());
    const state = await f.store.read();
    assert.equal(state.project.context.goal, expectedGoal);
    assert(state.conversationStartedAt);
    assert.equal(state.conversation?.filter(message => message.at >= state.conversationStartedAt!).at(0)?.text, expectedGoal);
    assert(state.conversation?.some(message => message.text === "旧项目"));
    assert.equal(state.tasks[0]?.status, "archived"); assert.deepEqual(state.tasks[0]?.runs, task.runs);
    assert(state.tasks[0]?.assessment.archiveReason); assert(state.tasks[0]?.assessment.reevaluateWhen.length);
    assert.equal(f.runtime.requests.length, calls);
  }
});

test("failed Collector input/raw replies survive relaunch; retry does not rerun Tutor", async t => {
  const f = await fixture(t, []); await f.session.initialize({ summary: "优化现有功能" });
  f.runtime.failCollector = true;
  const first = new OpenAGI(f.store, f.runtime);
  await assert.rejects(first.discover(), /Collector 输出未通过校验/);
  const failed = await f.store.read();
  assert.equal(failed.tasks.length, 0); assert.equal(failed.discoveryPending?.status, "failed");
  assert.equal(failed.discoveryPending?.candidates.length, 1); assert.equal(failed.discoveryPending?.replies.length, 2);
  assert.equal(f.runtime.discoveryCount, 3);
  f.runtime.failCollector = false;
  const relaunched = new OpenAGI(new ProjectStore(f.directory), f.runtime);
  const complete = await relaunched.discover();
  assert.equal(f.runtime.discoveryCount, 3); assert.equal(complete.discoveryPending, undefined);
  assert.equal(complete.tasks.length, 1); assert.equal(complete.collectorReplies?.length, 3);
  assert.equal(complete.discoveryHistory?.[0]?.candidates[0]?.id, failed.discoveryPending?.candidates[0]?.id);
  assert.equal(complete.discoveryHistory?.[0]?.result, "collected");
  assert.equal(await f.git("rev-parse", "HEAD"), f.base);
});

test("changed product context invalidates stale discovery candidates while preserving their evidence", async t => {
  const f = await fixture(t, []); await f.session.initialize({ summary: "旧方向" }); f.runtime.failCollector = true;
  const engine = new OpenAGI(f.store, f.runtime); await assert.rejects(engine.discover());
  await f.store.withLock(async () => { const state = await f.store.read(); state.project.context.goal = "新方向"; await f.store.write(state); });
  f.runtime.failCollector = false;
  const updated = await engine.discover();
  assert.equal(f.runtime.discoveryCount, 6);
  assert.equal(updated.discoveryHistory?.[0]?.result, "superseded");
  assert.equal(updated.discoveryHistory?.[1]?.result, "collected");
});


test("desktop workflow proceeds from discovery through test planning, Worker, Validator and merge without routine confirmations", async t => {
  const f = await fixture(t, ["退出"]);
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "完善核心功能" });
  await session.run();
  assert.equal((await f.store.read()).tasks[0]?.status, "merged");
  assert.equal(f.runtime.builds, 1);
  assert(f.runtime.requests.some(request => request.prompt.includes("Design executable")));
  assert(!f.io.prompts.some(prompt => prompt.includes("回车开始") || prompt.includes("采用这个测试方案")));
  assert.match(await readFile(join(f.directory, "feature.cjs"), "utf8"), /after/);
});

test("automatic desktop workflow still waits for a genuinely blocking user decision", async t => {
  const f = await fixture(t, ["退出"]); f.runtime.question = true;
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "改善核心功能", noChecks: true }); await session.run();
  assert.equal(f.runtime.builds, 0); assert(f.io.prompts.some(prompt => prompt.includes("主要服务谁")));
  assert.equal((await f.store.read()).tasks[0]?.status, "awaiting_user");
});

test("a fresh nested desktop project completes planning, isolated implementation, acceptance and merge without a retry", async t => {
  const f = await freshNestedFixture(t);
  const io = new ScriptIO(["退出"]);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.mode === "build") {
      assert.notEqual(request.directory, f.directory, "Worker runs in its task worktree");
      assert.equal(await f.parent.git("rev-parse", "HEAD"), f.parent.base);
      await assert.rejects(readFile(join(f.directory, "feature.cjs")), { code: "ENOENT" }, "the base has no implementation before acceptance");
    }
    return originalRun(request);
  };
  assert(await session.initialize({ summary: "交付可用的核心功能" }));
  await session.run();

  const state = await f.store.read();
  const task = state.tasks[0]!;
  const run = task.runs[0]!;
  assert.equal(task.status, "merged");
  assert.equal(task.runs.length, 1);
  assert.equal(run.status, "merged");
  assert.equal(run.workerCompleted, true);
  assert(run.workspace?.directory.startsWith(join(f.directory, ".openagi", "worktrees")));
  assert.equal(await f.git("rev-parse", "--show-toplevel"), await realpath(f.directory));
  assert.equal(await f.git("ls-tree", "-r", "--name-only", run.workspace!.baseCommit), "", "bootstrap does not track private state or parent files");
  assert.equal(await f.git("rev-parse", "HEAD"), run.validatedHead);
  assert.deepEqual((await f.git("ls-files")).split("\n"), ["feature.cjs", "feature.test.cjs"]);
  assert.match(await readFile(join(f.directory, "feature.cjs"), "utf8"), /after/);
  assert.deepEqual(run.checks.map(check => ({ name: check.name, ok: check.ok })), [{ name: "behavior", ok: true }]);
  assert.equal(run.acceptance?.criteria.length, criteria.length);
  assert(run.acceptance?.criteria.every(criterion => criterion.passed));
  assert.equal(f.runtime.builds, 1);
  assert.equal(f.runtime.requests.filter(request => request.purpose === "collector").length, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("Design executable")).length, 1);
  assert.equal(f.runtime.requests.filter(request => request.mode === "research").length, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("independent OpenAGI Validator")).length, 1);
  assert.equal(io.prompts.length, 0);
  assert.equal((await f.store.read()).awaitingInput, true);
  assert(io.output.some(text => text.includes("本轮工作已结束")));
  const completedCalls = f.runtime.requests.length;
  await session.initialize({ summary: "新的后续需求" });
  assert.equal((await f.store.read()).awaitingInput, false);
  assert.equal(f.runtime.requests.length, completedCalls);
  assert(!io.prompts.some(prompt => prompt.includes("重试") || prompt.includes("回车开始") || prompt.includes("采用这个测试方案")));
  assert.equal(await f.parent.git("rev-parse", "HEAD"), f.parent.base);
  assert.equal(await f.parent.git("status", "--porcelain"), "");
  assert.equal(await readFile(join(f.parent.directory, "feature.cjs"), "utf8"), "module.exports = () => 'before';\n");
  assert(!(await f.parent.git("branch", "--list", "openagi/*")), "parent has no task branches");
});

test("a failed preparation resumes the saved run and checks without repeating Collector or test planning", async t => {
  const f = await freshNestedFixture(t);
  const setupFile = join(f.directory, "setup.txt");
  await writeFile(setupFile, "existing project content requires an explicit Git setup\n");
  const firstIO = new ScriptIO(["退出"]);
  const first = new InteractiveSession(f.store, f.runtime, firstIO, undefined, { autoProceed: true });
  assert(await first.initialize({ summary: "交付可用的核心功能" }));
  await first.run();

  const failed = await f.store.read();
  const savedTask = failed.tasks[0]!;
  const savedRun = savedTask.runs[0]!;
  assert.equal(savedTask.status, "failed");
  assert.equal(savedRun.status, "failed");
  assert.equal(savedRun.workspace, undefined);
  assert.equal(savedRun.guidance, undefined);
  assert.equal(savedRun.workerCompleted, false);
  assert(savedRun.error);
  assert.equal(f.runtime.builds, 0);
  assert.equal(f.runtime.discoveryCount, 3);
  assert.equal(failed.discoveryPending, undefined);
  assert.equal(failed.discoveryHistory?.[0]?.result, "collected");
  assert.equal(failed.project.validation.checks[0]?.name, "behavior");
  assert.equal(firstIO.prompts.length, 1);
  assert.match(firstIO.prompts[0]!, /失败原因：[\s\S]*needs its own Git/);
  assert.equal(await readFile(setupFile, "utf8"), "existing project content requires an explicit Git setup\n");

  await rm(setupFile);
  let preWorkerSnapshot = false;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.mode === "build") {
      preWorkerSnapshot = true;
      assert.equal(f.runtime.discoveryCount, 3, "retry does not rerun Tutor before implementation");
      assert.equal(f.runtime.requests.filter(item => item.purpose === "collector").length, 1);
      assert.equal(f.runtime.requests.filter(item => item.prompt.includes("Design executable")).length, 1);
      const continuing = await f.store.read();
      assert.equal(continuing.tasks[0]?.runs.length, 1);
      assert.equal(continuing.tasks[0]?.runs[0]?.id, savedRun.id);
      assert.deepEqual(continuing.project.validation.checks, failed.project.validation.checks);
      assert.deepEqual(continuing.collectorReplies, failed.collectorReplies);
    }
    return originalRun(request);
  };
  const retryIO = new ScriptIO(["1", "退出"]);
  const retry = new InteractiveSession(new ProjectStore(f.directory), f.runtime, retryIO, undefined, { autoProceed: true });
  assert(await retry.initialize());
  await retry.run();

  const completed = await f.store.read();
  assert(preWorkerSnapshot);
  assert.equal(completed.tasks[0]?.id, savedTask.id);
  assert.equal(completed.tasks[0]?.status, "merged");
  assert.equal(completed.tasks[0]?.runs.length, 1);
  assert.equal(completed.tasks[0]?.runs[0]?.id, savedRun.id);
  assert.equal(completed.tasks[0]?.runs[0]?.error, undefined);
  assert.equal(f.runtime.builds, 1);
  assert.equal(f.runtime.requests.filter(request => request.purpose === "collector").length, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("Design executable")).length, 1);
  assert.equal(f.runtime.requests.filter(request => request.mode === "research").length, 1);
  assert.match(retryIO.prompts[0]!, /本次想做什么/);
  assert(!retryIO.prompts.some(prompt => prompt.includes("重试") || prompt.includes("采用这个测试方案")));
  assert.equal(await f.parent.git("rev-parse", "HEAD"), f.parent.base);
  assert.equal(await f.parent.git("status", "--porcelain"), "");
});

test("feedback queued during parallel discovery is remembered and reassessed before code execution", async t => {
  const f = await fixture(t, []);
  const io = new QueuedIO(["退出"]);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  const feedback = "这个功能必须适用于个人开发者";
  let queued = false;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.question = true;
  f.runtime.run = async request => {
    if (request.prompt.includes("function-finder") && !queued) { queued = true; io.enqueue(feedback); }
    if (request.prompt.includes("conversational project tutor")) {
      f.runtime.requests.push(request);
      assert.equal(f.runtime.builds, 0);
      return { sessionId: "queued-discussion", text: JSON.stringify({ reply: "已记录你的新增要求。", action: "discuss", taskId: null, updateContext: true }) };
    }
    return originalRun(request);
  };
  await session.initialize({ summary: "完善现有功能", noChecks: true });
  await session.run();
  const state = await f.store.read();
  assert.equal(f.runtime.builds, 0);
  assert.equal(state.conversation?.filter(message => message.role === "user" && message.text === feedback).length, 1);
  assert.equal(state.project.context.notes?.filter(note => note === feedback).length, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("conversational project tutor")).length, 1);
  assert(f.runtime.requests.filter(request => request.purpose === "collector").at(-1)?.prompt.includes(feedback));
});

test("feedback entered during test planning reaches Worker after task reassessment without replanning", async t => {
  const f = await fixture(t, []);
  const io = new QueuedIO(["退出"]);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  const feedback = "新增要求：保留现有导出函数";
  let queued = false;
  let revised = false;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.prompt.includes("Design executable") && !queued) { queued = true; io.enqueue(feedback); }
    if (request.prompt.includes("conversational project tutor")) {
      f.runtime.requests.push(request);
      return { sessionId: "planning-feedback", text: JSON.stringify({ reply: "保留现有导出接口。", action: "discuss", taskId: null, updateContext: true }) };
    }
    const reply = await originalRun(request);
    if (request.purpose === "collector" && request.prompt.includes(feedback)) {
      const value = JSON.parse(reply.text);
      value.groups[0].proposal.description += `。${feedback}`;
      revised = true;
      return { ...reply, text: JSON.stringify(value) };
    }
    if (request.mode === "build") assert(request.prompt.includes(feedback), "Worker receives the reassessed requirement");
    return reply;
  };
  await session.initialize({ summary: "完善现有功能" });
  await session.run();
  assert(revised);
  assert.equal((await f.store.read()).tasks[0]?.status, "merged");
  assert.equal(f.runtime.builds, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("Design executable")).length, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("conversational project tutor")).length, 1);
});

test("feedback queued during Worker waits for its complete acceptance and merge cycle, then informs the next analysis", async t => {
  const f = await fixture(t, []);
  const io = new QueuedIO(["退出"]);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  const feedback = "接下来增加重试操作";
  let queued = false;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.mode === "build" && !queued) { queued = true; io.enqueue(feedback); }
    if (request.prompt.includes("conversational project tutor")) {
      f.runtime.requests.push(request);
      assert.equal((await f.store.read()).tasks[0]?.status, "merged", "current Worker is completed without being relaunched");
      return { sessionId: "after-merge-feedback", text: JSON.stringify({ reply: "下一步会评估重试操作。", action: "discuss", taskId: null, updateContext: true }) };
    }
    return originalRun(request);
  };
  await session.initialize({ summary: "完善现有功能" });
  await session.run();
  const state = await f.store.read();
  assert.equal(state.tasks[0]?.status, "merged");
  assert.equal(f.runtime.builds, 1);
  assert.equal(state.conversation?.filter(message => message.role === "user" && message.text === feedback).length, 1);
  assert(state.project.context.notes?.includes(feedback));
  const discoveries = f.runtime.requests.filter(request => request.label === "Tutor · function-finder");
  assert.equal(discoveries.length, 2);
  assert(discoveries[1]?.prompt.includes(feedback));
});

async function promptReady(io: BrowserConversation, previous?: string) {
  const deadline = Date.now() + 5_000;
  while (!io.prompt || io.prompt.id === previous) {
    if (Date.now() >= deadline) throw new Error("Conversation did not reach its expected input boundary");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return io.prompt.id;
}

test("accepted Worker-time feedback survives pause and restart without rerunning the completed task", async t => {
  const f = await fixture(t, []);
  const queue = new ProjectInputQueue(f.directory);
  await queue.load();
  const controller = new AbortController();
  const io = new BrowserConversation(controller.signal, queue);
  const write = io.write.bind(io);
  io.write = text => { write(text); if (text.startsWith("\n已合并：")) controller.abort(); };
  const session = new InteractiveSession(f.store, f.runtime, io, controller.signal, { autoProceed: true });
  const feedback = "下一步增加键盘快捷键";
  let admitted = false;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.mode === "build" && !admitted) { admitted = true; await io.enqueue(feedback); }
    if (request.prompt.includes("conversational project tutor")) {
      f.runtime.requests.push(request);
      return { sessionId: "restored-feedback", text: JSON.stringify({ reply: "将评估快捷键需求。", action: "discuss", taskId: null, updateContext: true }) };
    }
    return originalRun(request);
  };
  await session.initialize({ summary: "完善现有功能" });
  await session.run();
  assert.equal((await f.store.read()).tasks[0]?.status, "merged");
  assert.equal(queue.count, 1);
  assert.equal(f.runtime.requests.filter(request => request.prompt.includes("conversational project tutor")).length, 0);
  const restored = new ProjectInputQueue(f.directory);
  await restored.load();
  const nextIO = new BrowserConversation(new AbortController().signal, restored);
  const next = new InteractiveSession(f.store, f.runtime, nextIO, undefined, { autoProceed: true });
  await next.run();
  assert.equal(nextIO.prompt, undefined);
  const state = await f.store.read();
  assert.equal(f.runtime.builds, 1);
  assert.equal(restored.count, 0);
  assert.equal(state.conversation?.filter(message => message.role === "user" && message.text === feedback).length, 1);
  assert(state.conversation?.find(message => message.text === feedback)?.sourceInputID);
  assert.equal(state.project.context.notes?.filter(note => note === feedback).length, 1);
});

test("failed durable feedback waits for an explicit retry and records its user message exactly once", async t => {
  const f = await fixture(t, []);
  const queue = new ProjectInputQueue(f.directory);
  await queue.load();
  await queue.enqueue("新增要求：保留原来的公开接口");
  const io = new BrowserConversation(new AbortController().signal, queue);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  let attempts = 0;
  const originalRun = f.runtime.run.bind(f.runtime);
  f.runtime.question = true;
  f.runtime.run = async request => {
    if (request.prompt.includes("conversational project tutor")) {
      f.runtime.requests.push(request);
      if (++attempts === 1) throw new Error("temporary model failure");
      return { sessionId: "retry-feedback", text: JSON.stringify({ reply: "已记录保留接口的要求。", action: "discuss", taskId: null, updateContext: true }) };
    }
    return originalRun(request);
  };
  await session.initialize({ summary: "完善现有功能", noChecks: true });
  const running = session.run();
  const recovery = await promptReady(io);
  assert.match(io.prompt!.text, /失败原因：temporary model failure/);
  assert.equal(attempts, 1);
  assert.equal(queue.count, 1);
  assert.equal(io.takeInput(), undefined, "the failed input stays parked while asking for recovery");
  io.answer(recovery, "");
  const next = await promptReady(io, recovery);
  assert.equal(attempts, 2);
  assert.equal(queue.count, 0);
  io.answer(next, "退出");
  await running;
  const state = await f.store.read();
  assert.equal(f.runtime.builds, 0);
  assert.equal(state.conversation?.filter(message => message.role === "user" && message.text === "新增要求：保留原来的公开接口").length, 1);
  assert.equal(state.project.context.notes?.filter(note => note === "新增要求：保留原来的公开接口").length, 1);
});

test("dirty source offers a real baseline action instead of endlessly retrying confirmations", async t => {
  const f = await fixture(t, []);
  await writeFile(join(f.directory, "user-note.txt"), "keep user changes\n");
  const io = new ScriptIO(["确认", "保存当前改动", "退出"]);
  const session = new InteractiveSession(f.store, f.runtime, io, undefined, { autoProceed: true });
  await session.initialize({ summary: "实现当前功能", noChecks: true });
  await session.run();
  assert(io.output.some(text => text.includes("普通确认不会改变 Git 状态")));
  assert.equal(f.runtime.builds, 1);
  assert((await f.store.read()).tasks.some(task => task.status === "merged"));
  assert.equal(await readFile(join(f.directory, "user-note.txt"), "utf8"), "keep user changes\n");
});


test("repeating the same failure pauses with a specific cause instead of repeatedly asking to confirm", async t => {
  const f = await fixture(t, ["重试"]);
  f.runtime.failCollector = true;
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "交付当前功能", noChecks: true });
  await session.run();
  assert.equal(f.io.prompts.length, 1);
  assert.match(f.io.prompts[0]!, /任务：分析项目[\s\S]*失败原因：/);
  assert(f.io.output.some(text => text.includes("相同错误已再次发生，已暂停")));
  assert.equal(f.runtime.discoveryCount, 3);
  assert.equal(f.runtime.builds, 0);
  assert((await f.store.read()).discoveryPending?.status === "failed");
});


test("an unexpected backend interruption resumes the same Worker once without asking the user to debug", async t => {
  const f = await fixture(t, ["退出"]);
  const original = f.runtime.run.bind(f.runtime);
  let stopped = false;
  f.runtime.run = async request => {
    if (request.mode === "build" && !stopped) {
      stopped = true;
      throw new OpenCodeError("interrupted", "backend inactivity evicted a parked question", "ses_saved");
    }
    if (request.mode === "build") {
      assert.equal(request.sessionId, "ses_saved");
      assert.match(request.prompt, /OpenAGI owns technical prerequisites/);
    }
    return original(request);
  };
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "恢复当前任务", noChecks: true });
  await session.run();
  assert((await f.store.read()).tasks.some(task => task.status === "merged"));
  assert.equal((await f.store.read()).tasks[0]?.runs.length, 1);
  assert(f.io.output.some(text => text.includes("正在恢复同一任务和工作区一次")));
  assert(f.io.prompts.every(prompt => !prompt.includes("失败原因")));
});

test("a second backend interruption stops with preserved context and never asks the user to fix an internal error", async t => {
  const f = await fixture(t, []);
  const original = f.runtime.run.bind(f.runtime);
  let interruptions = 0;
  f.runtime.run = async request => {
    if (request.mode === "build") {
      interruptions++;
      throw new OpenCodeError("interrupted", "waiting for a missing internal prerequisite", "ses_saved");
    }
    return original(request);
  };
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "修复会话恢复", noChecks: true });
  await session.run();
  assert.equal(interruptions, 2);
  assert.equal(f.io.prompts.length, 0);
  assert(f.io.output.some(text => text.includes("无需你处理内部错误")));
  const task = (await f.store.read()).tasks[0]!;
  assert.equal(task.status, "failed");
  assert.equal(task.runs.length, 1);
  assert.equal(task.runs[0]?.workerSessionId, "ses_saved");
});

test("resume revalidates an old numeric-only acceptance rejection without rerunning the completed Worker", async t => {
  const f = await fixture(t, ["退出"]);
  await f.session.initialize({ summary: "保持功能正确并减少重复工作", noChecks: true });
  const engine = new OpenAGI(f.store, f.runtime);
  const discovered = await engine.discover();
  const task = discovered.tasks[0]!;
  await engine.execute(task.id);
  const metric = "Rendering p95 improves by at least 20%";
  await f.store.withLock(async () => {
    const state = await f.store.read(); const saved = state.tasks[0]!; const run = saved.runs[0]!;
    saved.acceptanceCriteria.push(metric);
    run.acceptance!.criteria.push({ criterion: metric, passed: false, evidence: "Observed improvement is 15%.", kind: "requirement" });
    saved.status = "failed"; run.status = "failed"; run.error = "Independent acceptance rejected the task"; delete run.validatedHead;
    await f.store.write(state);
  });
  const original = f.runtime.run.bind(f.runtime);
  f.runtime.run = async request => {
    if (request.mode === "judge" && request.prompt.includes("independent OpenAGI Validator")) return { sessionId: "new-policy-validator", text: JSON.stringify({ criteria: [
      ...criteria.map(criterion => ({ criterion, passed: true, evidence: "Real functional checks remain valid." })),
      { criterion: metric, passed: false, evidence: "Observed improvement is 15%." },
    ], summary: "The numerical observation remains below 20%." }) };
    return original(request);
  };
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "保持功能正确并减少重复工作" });
  await session.run();
  assert.equal(f.runtime.builds, 1);
  assert.equal((await f.store.read()).tasks[0]?.status, "merged");
  assert.equal((await f.store.read()).tasks[0]?.runs.length, 1);
});

test("a completed round publishes source-backed usage guidance without another question or model call", async t => {
  const f = await fixture(t, []);
  await writeFile(join(f.directory, "README.md"), "# Example project\n\nA small reusable feature.\n\n## 使用方法\n调用 `require('./feature.cjs')()`。\n\n## 自动检查\n内部检查命令，不是启动说明。\n");
  await f.git("add", "README.md");
  await f.git("commit", "-m", "Document feature usage");
  const session = new InteractiveSession(f.store, f.runtime, f.io, undefined, { autoProceed: true });
  await session.initialize({ summary: "交付可用功能", noChecks: true });
  const { deliveryGuide } = await import("../src/delivery.js");
  assert.equal(await deliveryGuide(await f.store.read()), undefined);
  await session.run();
  const state = await f.store.read();
  assert.equal(state.awaitingInput, true);
  assert.equal(state.delivery?.source, "README.md");
  assert.match(state.delivery!.markdown, /require\('\.\/feature.cjs'\)/);
  assert(!state.delivery!.markdown.includes("内部检查命令"));
  assert.equal(state.delivery?.taskIDs[0], state.tasks[0]?.id);
  assert.equal(f.io.prompts.length, 0);
  assert(f.io.output.some(text => text.includes("使用说明（依据 README.md）")));
});
