import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConfig, Run, Task, type Assessment, type Proposal } from "../src/domain.js";
import { Collector, Tutor, candidateFromTask, type Candidate } from "../src/tutor.js";
import type { AgentRequest, AgentRuntime } from "../src/runtime.js";

const project = ProjectConfig.parse({
  name: "Test project", directory: "/tmp/openagi-tutor-test",
  modules: ["function-finder", "performance-optimizer", "ui-designer"],
  context: { goal: "Make the current workflow easier to use" }, opencode: {},
  validation: { checks: [] },
});
const proposal: Proposal = {
  title: "Save search filters", description: "Persist useful filters between visits",
  evidence: [{ location: "src/search.ts:filters", observation: "Filters reset after navigation" }],
  acceptanceCriteria: ["Saved filters survive navigation"], questions: [],
};
const assessment: Assessment = {
  necessity: 4, value: 5, urgency: 3, feasibility: 4, requirementClarity: 5,
  userDecisionRequired: false, rationale: "Repeated work affects the main user workflow", reevaluateWhen: [],
};
const candidate = (id: string): Candidate => ({ id, modules: ["function-finder"], proposal: structuredClone(proposal) });
const group = (ids: string[], changes: Partial<Assessment> = {}, changesToProposal: Partial<Proposal> = {}) => ({
  candidateIds: ids, proposal: { ...proposal, ...changesToProposal }, assessment: { ...assessment, ...changes },
});
function runtimeWithGroups(groups: unknown[]): { runtime: AgentRuntime; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  return {
    requests,
    runtime: {
      async run(request) { requests.push(request); return { sessionId: "collector-session", text: JSON.stringify({ groups }) }; },
      async search() { throw new Error("Collector must not search"); },
    },
  };
}
function previousTask(id: string, changes: Partial<Task> = {}): Task {
  return Task.parse({
    ...proposal, id, modules: ["function-finder"], assessment, priority: 84,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    status: "ready", runs: [], ...changes,
  });
}

test("Tutor starts configured modules concurrently and isolates a failed module", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: AgentRequest[] = [];
  const runtime: AgentRuntime = {
    async run(request) {
      requests.push(request);
      await gate;
      if (request.prompt.includes("Tutor's performance-optimizer")) throw new Error("model unavailable");
      return { sessionId: `session-${requests.length}`, text: JSON.stringify({ proposals: [proposal] }) };
    },
    async search() { throw new Error("Discovery must use OpenCode's existing tools"); },
  };
  const discovery = new Tutor(runtime).discover(project);
  try {
    assert.equal(requests.length, 3, "All modules must start before any model finishes");
    assert.ok(requests.every(request => request.mode === "observe" && request.directory === project.directory));
  } finally { release(); }
  const result = await discovery;
  assert.deepEqual(result.candidates.map(item => item.modules), [["function-finder"], ["ui-designer"]]);
  assert.equal(new Set(result.candidates.map(item => item.id)).size, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.module, "performance-optimizer");
  assert.match(result.errors[0]!.message, /model unavailable/);
  assert.ok(Number.isFinite(Date.parse(result.errors[0]!.at)));
});

test("Tutor treats malformed discovery output as a module-local failure", async () => {
  const runtime: AgentRuntime = {
    async run(request) {
      return { sessionId: "discovery", text: request.prompt.includes("Tutor's ui-designer")
        ? JSON.stringify({ proposals: [{ ...proposal, evidence: [] }] })
        : JSON.stringify({ proposals: [] }) };
    },
    async search() { return []; },
  };
  const result = await new Tutor(runtime).discover(project);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.module, "ui-designer");
});

test("Tutor never treats a model-supplied question answer as a user decision", async () => {
  const runtime: AgentRuntime = {
    async run() { return { sessionId: "discovery", text: JSON.stringify({ proposals: [{
      ...proposal, questions: [{ id: "scope", question: "Which filters?", answer: "The model chose all filters" }],
    }] }) }; },
    async search() { return []; },
  };
  const result = await new Tutor(runtime).discover({ ...project, modules: ["function-finder"] });
  assert.deepEqual(result.candidates[0]!.proposal.questions, [{ id: "scope", question: "Which filters?" }]);
});

test("Collector requires every input candidate exactly once and rejects invented IDs", async t => {
  const cases = [
    { name: "omitted candidate", groups: [group(["one"])], pattern: /omitted candidates/ },
    { name: "unknown candidate", groups: [group(["one", "invented"])], pattern: /unknown or duplicate candidate/ },
    { name: "duplicate in one group", groups: [group(["one", "one", "two"])], pattern: /unknown or duplicate candidate/ },
    { name: "duplicate across groups", groups: [group(["one", "two"]), group(["two"])], pattern: /unknown or duplicate candidate/ },
  ];
  for (const entry of cases) await t.test(entry.name, async () => {
    const { runtime } = runtimeWithGroups(entry.groups);
    await assert.rejects(new Collector(runtime).collect(project, [candidate("one"), candidate("two")]), entry.pattern);
  });
  const { runtime } = runtimeWithGroups([group(["one"])]);
  await assert.rejects(new Collector(runtime).collect(project, [candidate("one"), candidate("one")]), /Duplicate input candidate IDs/);
});

test("Collector rejects invalid score values and a non-boolean decision flag", async t => {
  for (const [name, changes] of [
    ["negative necessity", { necessity: -1 }], ["score above five", { value: 6 }],
    ["string score", { feasibility: "4" }],
    ["string decision", { userDecisionRequired: "false" }],
  ] as const) await t.test(name, async () => {
    const invalidGroup = { ...group(["one"]), assessment: { ...assessment, ...changes } };
    const { runtime } = runtimeWithGroups([invalidGroup]);
    await assert.rejects(new Collector(runtime).collect(project, [candidate("one")]));
  });
});

test("Collector archives low-necessity work only with a reason and reevaluation conditions", async t => {
  for (const changes of [
    { necessity: 1, archiveReason: undefined, reevaluateWhen: ["Weekly usage grows"] },
    { necessity: 1, archiveReason: "   ", reevaluateWhen: ["Weekly usage grows"] },
    { necessity: 1, archiveReason: "Low usage", reevaluateWhen: [] },
  ]) await t.test(JSON.stringify(changes), async () => {
    const { runtime } = runtimeWithGroups([group(["one"], changes)]);
    await assert.rejects(new Collector(runtime).collect(project, [candidate("one")]), /reason and reevaluation conditions/);
  });
  const { runtime } = runtimeWithGroups([group(["one"], {
    necessity: 1, archiveReason: "The workflow is used infrequently", reevaluateWhen: ["Usage exceeds 100 weekly users"],
  })]);
  const tasks = await new Collector(runtime).collect(project, [candidate("one")]);
  assert.equal(tasks[0]!.status, "archived");
  assert.equal(tasks[0]!.assessment.archiveReason, "The workflow is used infrequently");
  assert.deepEqual(tasks[0]!.assessment.reevaluateWhen, ["Usage exceeds 100 weekly users"]);
});

test("Collector gates readiness on blocking questions and decisions, not clarity alone", async t => {
  const unanswered = [{ id: "filter-scope", question: "Which filters should persist?" }];
  for (const changes of [{}, { requirementClarity: 2 }, { userDecisionRequired: true }]) {
    await t.test(`unanswered question with ${JSON.stringify(changes)}`, async () => {
      const { runtime } = runtimeWithGroups([group(["one"], changes, { questions: unanswered })]);
      const tasks = await new Collector(runtime).collect(project, [candidate("one")]);
      assert.equal(tasks[0]!.status, "awaiting_user");
    });
  }
  for (const changes of [{ userDecisionRequired: true }]) {
    await t.test(`incomplete judgement ${JSON.stringify(changes)}`, async () => {
      const { runtime } = runtimeWithGroups([group(["one"], changes)]);
      await assert.rejects(new Collector(runtime).collect(project, [candidate("one")]), /must include an unanswered question/);
    });
  }
  const lowClarity = runtimeWithGroups([group(["one"], { requirementClarity: 2 })]);
  assert.equal((await new Collector(lowClarity.runtime).collect(project, [candidate("one")]))[0]!.status, "ready");
  const humanAnswer = previousTask("one", { questions: [{ ...unanswered[0]!, answer: "All filters" }] });
  const { runtime } = runtimeWithGroups([group(["one"], {}, { questions: unanswered })]);
  assert.equal((await new Collector(runtime).collect(project, [candidateFromTask(humanAnswer)]))[0]!.status, "ready");
});

test("Collector ignores fabricated model answers and keeps the question unresolved", async () => {
  const { runtime } = runtimeWithGroups([group(["one"], {}, { questions: [
    { id: "scope", question: "Which filters should persist?", answer: "The model picked all filters" },
  ] })]);
  const tasks = await new Collector(runtime).collect(project, [candidate("one")]);
  assert.equal(tasks[0]!.status, "awaiting_user");
  assert.equal(tasks[0]!.questions[0]!.answer, undefined);
});

test("Collector preserves answered user decisions and existing execution history", async () => {
  const question = { id: "filter-scope", question: "Which filters should persist?", answer: "Only tags and date" };
  const existing = previousTask("stable-task", {
    questions: [question],
    runs: [Run.parse({ id: "past-run", createdAt: "2026-01-03T00:00:00.000Z", status: "failed", error: "Build failed" })],
  });
  const { runtime } = runtimeWithGroups([group([existing.id], {}, { questions: [{ ...question, id: "model-renamed-id", answer: "All filters" }] })]);
  const tasks = await new Collector(runtime).collect(project, [candidateFromTask(existing)]);
  assert.equal(tasks[0]!.id, existing.id);
  assert.equal(tasks[0]!.createdAt, existing.createdAt);
  assert.equal(tasks[0]!.questions[0]!.answer, question.answer);
  assert.equal(tasks[0]!.questions[0]!.id, question.id);
  assert.deepEqual(tasks[0]!.runs, existing.runs);
  assert.equal(tasks[0]!.status, "ready");
});

test("Collector retains answered user decisions even if Jev omits their questions", async () => {
  const question = { id: "filter-scope", question: "Which filters should persist?", answer: "Only tags and date" };
  const existing = previousTask("stable-task", { questions: [question] });
  const { runtime } = runtimeWithGroups([group([existing.id])]);
  const tasks = await new Collector(runtime).collect(project, [candidateFromTask(existing)]);
  assert.deepEqual(tasks[0]!.questions, [question]);
});

test("Collector keeps the historical decision when Jev rephrases its question", async () => {
  const question = { id: "filter-scope", question: "Which filters should persist?", answer: "Only tags and date" };
  const existing = previousTask("stable-task", { questions: [question] });
  const { runtime } = runtimeWithGroups([group([existing.id], {}, { questions: [
    { id: "new-scope", question: "Should sorting also persist?" },
  ] })]);
  const tasks = await new Collector(runtime).collect(project, [candidateFromTask(existing)]);
  assert.ok(tasks[0]!.questions.some(item => item.id === question.id && item.answer === question.answer));
  assert.ok(tasks[0]!.questions.some(item => item.id === "new-scope" && item.answer === undefined));
  assert.equal(tasks[0]!.status, "awaiting_user");
});

test("Collector keeps archived work archived until explicitly reevaluated", async () => {
  const existing = previousTask("archived-task", {
    status: "archived", assessment: { ...assessment, necessity: 1, archiveReason: "Too few users", reevaluateWhen: ["More than 100 users"] },
  });
  const { runtime } = runtimeWithGroups([group([existing.id])]);
  const collector = new Collector(runtime);
  const archived = (await collector.collect(project, [candidateFromTask(existing)]))[0]!;
  assert.equal(archived.status, "archived");
  assert.equal(archived.assessment.archiveReason, "Too few users");
  assert.deepEqual(archived.assessment.reevaluateWhen, ["More than 100 users"]);
  assert.equal((await collector.collect(project, [candidateFromTask(existing)], true))[0]!.status, "ready");
});

test("Collector preserves merged candidate history as archived records", async () => {
  const first = previousTask("first", { runs: [Run.parse({ id: "first-run", createdAt: "2026-01-03", status: "failed" })] });
  const second = previousTask("second", { modules: ["ui-designer"], runs: [Run.parse({ id: "second-run", createdAt: "2026-01-04", status: "failed" })] });
  const { runtime } = runtimeWithGroups([group([first.id, second.id])]);
  const tasks = await new Collector(runtime).collect(project, [candidateFromTask(first), candidateFromTask(second)]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]!.id, first.id);
  assert.deepEqual(tasks[0]!.modules, ["function-finder", "ui-designer"]);
  assert.deepEqual(tasks[0]!.runs, first.runs);
  assert.equal(tasks[1]!.id, second.id);
  assert.equal(tasks[1]!.status, "archived");
  assert.deepEqual(tasks[1]!.runs, second.runs);
  assert.match(tasks[1]!.assessment.archiveReason!, /Consolidated into first/);
  assert.ok(tasks[1]!.assessment.reevaluateWhen.length > 0);
});

test("Collector retains distinct historical decisions that share the same question text", async () => {
  const question = "Who should use this feature?";
  const first = previousTask("first", { questions: [{ id: "first-audience", question, answer: "Internal operators" }] });
  const second = previousTask("second", { questions: [{ id: "second-audience", question, answer: "External customers" }] });
  const { runtime } = runtimeWithGroups([group([first.id, second.id])]);
  const tasks = await new Collector(runtime).collect(project, [candidateFromTask(first), candidateFromTask(second)]);
  assert.ok(tasks[0]!.questions.some(item => item.id === "first-audience" && item.answer === "Internal operators"));
  assert.ok(tasks[0]!.questions.some(item => item.id === "second-audience" && item.answer === "External customers"));
});

test("Collector rejects duplicate question IDs and skips empty input", async () => {
  const { runtime, requests } = runtimeWithGroups([group(["one"], {}, { questions: [
    { id: "scope", question: "Which filters?" }, { id: "scope", question: "Which users?" },
  ] })]);
  const collector = new Collector(runtime);
  assert.deepEqual(await collector.collect(project, []), []);
  assert.equal(requests.length, 0);
  await assert.rejects(collector.collect(project, [candidate("one")]), /duplicate question IDs|Question IDs must be unique/);
});

test("missing reevaluateWhen on normal proposals becomes an empty array without another model call", async () => {
  const normal = group(["one"]);
  delete (normal.assessment as Partial<Assessment>).reevaluateWhen;
  const { runtime, requests } = runtimeWithGroups([normal]);
  const tasks = await new Collector(runtime).collect(project, [candidate("one")]);
  assert.deepEqual(tasks[0]?.assessment.reevaluateWhen, []);
  assert.equal(tasks[0]?.status, "ready"); assert.equal(requests.length, 1);
});

test("missing reevaluation conditions on an archive still fails after a bounded repair attempt", async () => {
  const archived = group(["one"], { necessity: 1, archiveReason: "Low value" });
  delete (archived.assessment as Partial<Assessment>).reevaluateWhen;
  const { runtime, requests } = runtimeWithGroups([archived]);
  await assert.rejects(new Collector(runtime).collect(project, [candidate("one")]), /reason and reevaluation conditions/);
  assert.equal(requests.length, 2); assert.match(requests[1]!.prompt, /Validation error/);
});

test("a malformed Collector output is corrected using the original candidates and saved as raw attempts", async () => {
  const requests: AgentRequest[] = [];
  const attempts: { text: string; error?: string }[] = [];
  const runtime: AgentRuntime = { async run(request) {
    requests.push(request); return { sessionId: `attempt-${requests.length}`, text: JSON.stringify({ groups: requests.length === 1 ? [] : [group(["one"])] }) };
  }, async search() { return []; } };
  const tasks = await new Collector(runtime).collect(project, [candidate("one")], false, async attempt => { attempts.push(attempt); });
  assert.equal(tasks.length, 1); assert.equal(requests.length, 2);
  assert.match(requests[1]!.prompt, /Previous response/); assert.match(requests[1]!.prompt, /omitted candidates/);
  assert.deepEqual(requests[0]!.evaluation?.candidates, requests[1]!.evaluation?.candidates);
  assert(attempts.some(attempt => attempt.error)); assert.equal(attempts.at(-1)?.error, undefined);
});


test("Collector receives user evidence separately from generated suggestions and future conditions", async () => {
  const existing = previousTask("origin", { questions: [{ id: "scope", question: "Which filters?", answer: "Only tags" }] });
  const { runtime, requests } = runtimeWithGroups([group(["origin"])]);
  await new Collector(runtime).collect(project, [candidateFromTask(existing)]);
  const line = requests[0]!.prompt.split("\n").find(line => line.startsWith("Confirmed user inputs"))!;
  const evidence = JSON.parse(line.slice(line.indexOf(": ") + 2));
  assert.deepEqual(evidence.answers, [{ taskID: "origin", questionID: "scope", question: "Which filters?", answer: "Only tags" }]);
  assert.equal(evidence.goal, project.context.goal);
  assert.equal(evidence.reevaluateWhen, undefined);
});
