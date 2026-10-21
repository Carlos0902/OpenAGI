import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ProjectConfig, Task, type State } from "../src/domain.js";
import { OpenAGI } from "../src/engine.js";
import type { AgentReply, AgentRequest, AgentRuntime, SearchSource } from "../src/runtime.js";
import { ProjectStore } from "../src/store.js";

const executeFile = promisify(execFile);
const criteria = ["The feature returns after", "A regression test verifies the feature behavior"];
const assessment = {
  necessity: 4, value: 4, urgency: 3, feasibility: 5, requirementClarity: 5,
  userDecisionRequired: false, rationale: "A concrete user need is supported by the existing feature.", reevaluateWhen: [],
};
const guidance = {
  summary: "Reuse the existing feature implementation and its Node regression test.",
  approach: "Change the return value and update the behavior test.", alternatives: [],
  integrationSteps: ["Update feature.cjs", "Update feature.test.cjs to exercise the new behavior"],
  risks: ["Existing callers may expect the previous value"], dependencies: [],
  validationPlan: ["Run the Node regression suite and independently inspect the committed implementation"],
};
const source: SearchSource = {
  title: "Node test runner documentation", url: "https://nodejs.org/api/test.html", description: "Official test runner documentation",
};
const implementation = "module.exports = () => 'after';\n";
const regression = "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('feature behavior', () => assert.equal(require('./feature.cjs')(), 'after'));\n";

async function git(directory: string, ...args: string[]): Promise<string> {
  return (await executeFile("git", ["-C", directory, ...args])).stdout.trim();
}

type FakeOptions = {
  build?: (request: AgentRequest, attempt: number) => Promise<void>;
  accept?: (request: AgentRequest) => Promise<{ criteria: { criterion: string; passed: boolean; evidence: string }[]; summary: string }>;
};

class FakeRuntime implements AgentRuntime {
  readonly requests: AgentRequest[] = [];
  readonly searches: { directory: string; query: string }[] = [];
  private buildAttempt = 0;
  constructor(private options: FakeOptions = {}) {}

  async search(request: { directory: string; query: string }): Promise<SearchSource[]> {
    this.searches.push(request);
    return [source];
  }

  async run(request: AgentRequest): Promise<AgentReply> {
    this.requests.push(request);
    if (request.mode === "research") return { sessionId: "guider-session", text: JSON.stringify(guidance) };
    if (request.mode === "build") {
      this.buildAttempt++;
      if (this.options.build) await this.options.build(request, this.buildAttempt);
      else await implement(request.directory);
      return { sessionId: request.sessionId ?? "worker-session", text: "Implementation and regression test updated." };
    }
    if (request.mode === "judge" && request.prompt.includes("independent Collector")) {
      const candidates = JSON.parse(request.prompt.split("\nCandidates: ")[1]!.split("\n")[0]!);
      return { sessionId: "collector-session", text: JSON.stringify({ groups: [{
        candidateIds: [candidates[0].id],
        proposal: { ...candidates[0].proposal, description: "Implement the user-selected scope: export only.", questions: [] },
        assessment,
      }] }) };
    }
    if (request.mode === "judge") {
      const acceptance = this.options.accept ? await this.options.accept(request) : {
        criteria: criteria.map(criterion => ({ criterion, passed: true, evidence: "feature.cjs implements the new return value; feature.test.cjs verifies it and the configured Node test passed." })),
        summary: "The implementation and regression test satisfy the selected task.",
      };
      return { sessionId: "validator-session", text: JSON.stringify(acceptance) };
    }
    throw new Error(`Unexpected fake runtime mode ${request.mode}`);
  }
}

async function implement(directory: string): Promise<void> {
  await writeFile(join(directory, "feature.cjs"), implementation);
  await writeFile(join(directory, "feature.test.cjs"), regression);
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, options: {
  runtime?: FakeRuntime; checks?: State["project"]["validation"]["checks"]; requireChecks?: boolean; question?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-engine-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await git(directory, "init", "-b", "main");
  await git(directory, "config", "user.name", "OpenAGI Test");
  await git(directory, "config", "user.email", "openagi-test@example.invalid");
  await git(directory, "config", "commit.gpgsign", "false");
  await writeFile(join(directory, ".gitignore"), ".openagi/\nignored-output/\n");
  await writeFile(join(directory, "feature.cjs"), "module.exports = () => 'before';\n");
  await writeFile(join(directory, "feature.test.cjs"), regression.replace("'after'", "'before'"));
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "initial project");
  const baseHead = await git(directory, "rev-parse", "HEAD");
  const store = new ProjectStore(directory);
  const runtime = options.runtime ?? new FakeRuntime();
  const now = new Date().toISOString();
  const task = Task.parse({
    id: "task-feature", title: "Improve the feature", description: "Return the selected result and exercise it with a regression test.",
    evidence: [{ location: "feature.cjs", observation: "The current feature returns before." }],
    acceptanceCriteria: criteria, questions: options.question ? [{ id: "scope", question: "Which workflow should be supported?" }] : [],
    modules: ["function-finder"], status: options.question ? "awaiting_user" : "ready",
    createdAt: now, updatedAt: now, assessment: options.question ? { ...assessment, userDecisionRequired: true, requirementClarity: 2 } : assessment,
    priority: 85, runs: [],
  });
  const state: State = {
    version: 1,
    project: ProjectConfig.parse({
      name: "Engine integration fixture", directory, modules: ["function-finder"], context: { goal: "Improve the existing feature" }, opencode: {},
      models: { worker: { providerID: "test", modelID: "worker" }, validator: { providerID: "test", modelID: "independent-validator" } },
      validation: { requireChecks: options.requireChecks ?? true, checks: options.checks ?? [{ name: "Node regression tests", command: process.execPath, args: ["--test", "--test-reporter=tap", "feature.test.cjs"], timeoutMs: 5_000 }] },
    }),
    tasks: [task], discoveryErrors: [],
  };
  await store.withLock(() => store.write(state));
  return { directory, baseHead, store, runtime, task, engine: new OpenAGI(store, runtime) };
}

test("guidance, Worker, committed checks and independent acceptance complete before explicit merge", async (t) => {
  const { engine, store, runtime, task, directory, baseHead } = await fixture(t);
  const completed = await engine.execute(task.id);
  assert.equal(completed.status, "validated");
  const run = completed.runs[0]!;
  assert.equal(run.status, "validated");
  assert.equal(run.workerCompleted, true);
  assert.equal(run.sources.length, 1, "duplicate search sources are consolidated");
  assert.equal(run.searchErrors.length, 0);
  assert.deepEqual(run.guidance, guidance);
  assert.equal(run.checks[0]?.ok, true);
  assert.match(`${run.checks[0]!.stdout}\n${run.checks[0]!.stderr}`, /feature behavior/, JSON.stringify(run.checks[0]));
  assert.equal(run.validatedHead, run.workspace?.headCommit);
  assert.notEqual(run.validatedHead, baseHead);
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
  assert.match(await readFile(join(directory, "feature.cjs"), "utf8"), /before/);
  assert.deepEqual(runtime.requests.map(request => request.mode), ["research", "build", "judge"]);
  assert.equal(runtime.searches.length, 2);
  const worker = runtime.requests[1]!;
  const validator = runtime.requests[2]!;
  assert.equal(worker.directory, run.workspace!.directory);
  assert.equal(validator.directory, worker.directory);
  assert.equal(validator.sessionId, undefined);
  assert.equal(validator.model?.modelID, "independent-validator");
  assert.notEqual(run.workerSessionId, run.validatorSessionId);
  assert.match(worker.prompt, /Implementation guidance/);
  assert.match(validator.prompt, /Committed diff/);
  assert.match(validator.prompt, /\+module.exports = \(\) => 'after'/);
  const merged = await engine.merge(task.id);
  assert.equal(merged.status, "merged");
  assert.equal(await git(directory, "rev-parse", "HEAD"), run.validatedHead);
  assert.equal(await readFile(join(directory, "feature.cjs"), "utf8"), implementation);
  assert.equal((await store.read()).tasks[0]?.runs[0]?.status, "merged");
  await access(run.workspace!.directory);
});

test("failed configured checks retain evidence and worktree and prevent merging", async (t) => {
  const { engine, store, task, directory, runtime, baseHead } = await fixture(t, { checks: [{
    name: "failed check", command: process.execPath, args: ["-e", "console.error('regression found'); process.exit(2)"], timeoutMs: 5_000,
  }] });
  await assert.rejects(engine.execute(task.id), /Configured static checks\/tests failed/);
  const failed = (await store.read()).tasks[0]!;
  assert.equal(failed.status, "failed");
  const run = failed.runs[0]!;
  assert.equal(run.workerCompleted, true);
  assert.equal(run.status, "failed");
  assert.equal(run.validatedHead, undefined);
  assert.match(run.checks[0]!.stderr, /regression found/);
  assert.equal(runtime.requests.filter(request => request.mode === "judge").length, 0);
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
  await access(run.workspace!.directory);
  await assert.rejects(engine.merge(task.id), /independently validated/);
});

test("independent acceptance must evaluate every criterion exactly once", async (t) => {
  const runtime = new FakeRuntime({ accept: async () => ({
    criteria: [{ criterion: criteria[0]!, passed: true, evidence: "feature.cjs contains the requested value." }], summary: "The reviewer omitted the regression criterion.",
  }) });
  const { engine, task, store, baseHead, directory } = await fixture(t, { runtime });
  await assert.rejects(engine.execute(task.id), /every acceptance criterion exactly once/);
  const run = (await store.read()).tasks[0]!.runs[0]!;
  assert.equal(run.checks[0]?.ok, true);
  assert.equal(run.acceptance?.criteria.length, 1);
  assert.equal(run.validatedHead, undefined);
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
  await assert.rejects(engine.merge(task.id), /independently validated/);
});

test("checks that change source files cannot produce accepted work", async (t) => {
  const { engine, task, store, runtime, directory, baseHead } = await fixture(t, { checks: [{
    name: "source-mutating check", command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('feature.cjs', \"module.exports = () => 'unexpected';\\n\")"], timeoutMs: 5_000,
  }] });
  await assert.rejects(engine.execute(task.id), /uncommitted or untracked changes/);
  const run = (await store.read()).tasks[0]!.runs[0]!;
  assert.equal(run.checks[0]?.ok, true, "a zero exit code is insufficient after input mutation");
  assert.equal(run.validatedHead, undefined);
  assert.equal(runtime.requests.filter(request => request.mode === "judge").length, 0);
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
});

test("source changes during independent acceptance invalidate the acceptance", async (t) => {
  const runtime = new FakeRuntime({ accept: async (request) => {
    await writeFile(join(request.directory, "unreviewed.cjs"), "module.exports = 'unexpected';\n");
    return {
      criteria: criteria.map(criterion => ({ criterion, passed: true, evidence: "The configured regression test passed." })),
      summary: "An acceptance response cannot hide concurrent source changes.",
    };
  } });
  const { engine, store, task, directory, baseHead } = await fixture(t, { runtime });
  await assert.rejects(engine.execute(task.id), /uncommitted or untracked changes/);
  const failed = (await store.read()).tasks[0]!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.runs[0]?.validatedHead, undefined);
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
  await assert.rejects(engine.merge(task.id), /independently validated/);
});

test("pending Worker sessions and partial files are persisted and resumed in the same worktree", async (t) => {
  const runtime = new FakeRuntime({ build: async (request, attempt) => {
    if (attempt === 1) {
      await writeFile(join(request.directory, "feature.cjs"), implementation);
      throw Object.assign(new Error("Upstream user question requires attention"), { sessionId: "worker-pending" });
    }
    assert.equal(request.sessionId, "worker-pending");
    assert.equal(await readFile(join(request.directory, "feature.cjs"), "utf8"), implementation);
    await implement(request.directory);
  } });
  const { engine, store, task, directory, baseHead } = await fixture(t, { runtime });
  await assert.rejects(engine.execute(task.id), /Upstream user question/);
  const failed = (await store.read()).tasks[0]!;
  const interruptedRun = failed.runs[0]!;
  assert.equal(interruptedRun.workerSessionId, "worker-pending");
  assert.equal(interruptedRun.workerCompleted, false);
  assert.equal(failed.status, "failed");
  assert.equal(await git(directory, "rev-parse", "HEAD"), baseHead);
  const resumed = await engine.execute(task.id, { resume: true });
  assert.equal(resumed.status, "validated");
  assert.equal(resumed.runs.length, 1);
  assert.equal(resumed.runs[0]?.id, interruptedRun.id);
  assert.equal(resumed.runs[0]?.workspace?.directory, interruptedRun.workspace?.directory);
  assert.equal(resumed.runs[0]?.workerSessionId, "worker-pending");
  assert.equal(runtime.requests.filter(request => request.mode === "research").length, 1);
  assert.equal(runtime.searches.length, 2);
});

test("required configured checks gate execution before creating a run or calling models", async (t) => {
  const { engine, task, store, runtime } = await fixture(t, { checks: [] });
  await assert.rejects(engine.execute(task.id), /Configure validation checks before running Worker/);
  assert.equal((await store.read()).tasks[0]?.status, "ready");
  assert.equal((await store.read()).tasks[0]?.runs.length, 0);
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.searches.length, 0);
});

test("an explicit check waiver still requires independent acceptance", async (t) => {
  const { engine, task, runtime } = await fixture(t, { checks: [], requireChecks: false });
  const completed = await engine.execute(task.id);
  assert.equal(completed.status, "validated");
  assert.equal(completed.runs[0]?.checks.length, 0);
  assert.equal(completed.runs[0]?.acceptance?.criteria.length, 2);
  assert.equal(runtime.requests.filter(request => request.mode === "judge").length, 1);
});

test("user answers are persisted, refine task scope and flow into the Worker prompt", async (t) => {
  const { engine, store, task, runtime } = await fixture(t, { question: true });
  await assert.rejects(engine.execute(task.id), /Task must be ready/);
  const refined = await engine.answer(task.id, "scope", "  Support export only  ");
  assert.equal(refined.id, task.id);
  assert.equal(refined.status, "ready");
  assert.match(refined.description, /export only/);
  assert.equal(refined.questions[0]?.id, "scope");
  assert.equal(refined.questions[0]?.answer, "Support export only");
  assert.equal((await store.read()).tasks[0]?.questions[0]?.answer, "Support export only");
  const completed = await engine.execute(task.id);
  assert.equal(completed.status, "validated");
  const worker = runtime.requests.find(request => request.mode === "build")!;
  assert.match(worker.prompt, /Support export only/);
  assert.match(worker.prompt, /export only/);
});

test("unanswered optional questions do not cause another interview after a blocking answer", async t => {
  const { engine, task, runtime, store } = await fixture(t, { question: true });
  await store.withLock(async () => {
    const state = await store.read(); state.tasks[0]!.questions.push({ id: "learning", question: "需要额外教学内容？", blocking: false }); await store.write(state);
  });
  const refined = await engine.answer(task.id, "scope", "Support export only");
  assert.equal(refined.status, "ready");
  assert.equal(runtime.requests.filter(request => request.purpose === "collector").length, 1);
  assert.equal(refined.questions.find(question => question.id === "scope")?.answer, "Support export only");
});

test("rebasing a validated task onto a moved base requires fresh checks and independent acceptance", async (t) => {
  const { engine, task, runtime, directory } = await fixture(t);
  const original = await engine.execute(task.id);
  const previousHead = original.runs[0]!.validatedHead;
  await writeFile(join(directory, "user-feature.txt"), "Concurrent user feature\n");
  await git(directory, "add", "user-feature.txt");
  await git(directory, "commit", "-m", "concurrent user feature");
  const movedBase = await git(directory, "rev-parse", "HEAD");
  await assert.rejects(engine.merge(task.id), /base branch moved/);
  const rebased = await engine.rebase(task.id);
  const run = rebased.runs[0]!;
  assert.equal(rebased.status, "validated");
  assert.equal(run.workspace?.baseCommit, movedBase);
  assert.notEqual(run.validatedHead, previousHead);
  assert.equal(run.checks[0]?.ok, true);
  assert.equal(await git(directory, "rev-parse", "HEAD"), movedBase);
  assert.equal(runtime.requests.filter(request => request.mode === "build").length, 1);
  assert.equal(runtime.requests.filter(request => request.mode === "research").length, 1);
  const reviewers = runtime.requests.filter(request => request.mode === "judge");
  assert.equal(reviewers.length, 2);
  assert.ok(reviewers.every(request => request.sessionId === undefined));
  await engine.merge(task.id);
  assert.equal(await readFile(join(directory, "feature.cjs"), "utf8"), implementation);
  assert.equal(await readFile(join(directory, "user-feature.txt"), "utf8"), "Concurrent user feature\n");
});

test("a rebase conflict invalidates prior acceptance and preserves both source and task worktree", async (t) => {
  const { engine, task, store, runtime, directory } = await fixture(t);
  const original = await engine.execute(task.id);
  await writeFile(join(directory, "feature.cjs"), "module.exports = () => 'user choice';\n");
  await git(directory, "add", "feature.cjs");
  await git(directory, "commit", "-m", "concurrent conflicting user feature");
  const sourceHead = await git(directory, "rev-parse", "HEAD");
  await assert.rejects(engine.rebase(task.id), /rebase failed.*source branch was preserved/);
  const failed = (await store.read()).tasks[0]!;
  const run = failed.runs[0]!;
  assert.equal(failed.status, "failed");
  assert.equal(run.status, "failed");
  assert.equal(run.validatedHead, undefined);
  assert.equal(run.acceptance, undefined);
  assert.equal(run.validatorSessionId, undefined);
  assert.equal(run.workspace?.directory, original.runs[0]?.workspace?.directory);
  assert.equal(await git(directory, "rev-parse", "HEAD"), sourceHead);
  assert.match(await readFile(join(directory, "feature.cjs"), "utf8"), /user choice/);
  assert.match(await git(run.workspace!.directory, "status", "--porcelain"), /UU feature.cjs/);
  assert.equal(runtime.requests.filter(request => request.mode === "judge").length, 1);
  await assert.rejects(engine.merge(task.id), /independently validated/);
  await assert.rejects(engine.rebase(task.id), /rebase is still in progress/);
  await git(run.workspace!.directory, "rebase", "--abort");
  assert.equal(await readFile(join(run.workspace!.directory, "feature.cjs"), "utf8"), implementation);
});


test("numeric performance observations cannot block a correct validated change, while functional failures still block", async t => {
  const metric = "Rendering p95 improves by at least 20%";
  for (const functionalPassed of [true, false]) {
    const runtime = new FakeRuntime({ accept: async () => ({ criteria: [
      { criterion: criteria[0]!, passed: functionalPassed, evidence: functionalPassed ? "Actual code and behavioral tests agree." : "The required return value is wrong.", kind: "measurement" },
      { criterion: criteria[1]!, passed: true, evidence: "The regression test exercises the real behavior." },
      { criterion: metric, passed: false, evidence: "The measured improvement is 15%, with no functional regression." },
    ], summary: "The percentage target was not achieved." }) });
    const f = await fixture(t, { runtime });
    await f.store.withLock(async () => { const state = await f.store.read(); state.tasks[0]!.acceptanceCriteria.push(metric); await f.store.write(state); });
    if (functionalPassed) {
      const result = await f.engine.execute(f.task.id);
      assert.equal(result.status, "validated");
      assert.equal(result.runs[0]?.acceptance?.criteria.at(-1)?.kind, "measurement");
      assert(result.runs[0]?.acceptance?.rawSummary);
      await f.engine.merge(f.task.id);
      assert.equal((await f.store.read()).tasks[0]?.status, "merged");
    } else {
      await assert.rejects(f.engine.execute(f.task.id), /未通过标准：The feature returns after[\s\S]*required return value is wrong/);
      assert.equal((await f.store.read()).tasks[0]?.status, "failed");
      assert.equal(await git(f.directory, "rev-parse", "HEAD"), f.baseHead);
    }
  }
});
