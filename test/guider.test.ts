import assert from "node:assert/strict";
import test from "node:test";
import { ProjectConfig, Task, type Guidance } from "../src/domain.js";
import { ProblemSolvingGuider } from "../src/guider.js";
import type { AgentRequest, AgentRuntime, SearchSource } from "../src/runtime.js";

const project = ProjectConfig.parse({
  name: "Test project", directory: "/tmp/original-project", modules: ["function-finder"],
  context: { goal: "Make search responsive" }, opencode: {}, validation: { checks: [] },
  models: { guider: { providerID: "test-provider", modelID: "research-model" } },
});
const task = Task.parse({
  id: "search-task", title: "Improve search latency", description: "Avoid repeated scans on every keystroke",
  evidence: [{ location: "src/search.ts", observation: "Search scans every record" }],
  acceptanceCriteria: ["P95 search latency below 100ms at 10,000 records"],
  questions: [{ id: "workload", question: "How many records?", answer: "10,000 records" }],
  modules: ["performance-optimizer"], status: "ready", priority: 90, runs: [],
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
  assessment: { necessity: 5, value: 5, urgency: 4, feasibility: 4, requirementClarity: 5, userDecisionRequired: false, rationale: "Main workflow", reevaluateWhen: [] },
});
const guidance: Guidance = {
  summary: "Add a measured search index", approach: "Benchmark first, then build an incremental index",
  alternatives: ["Debounce existing search"], integrationSteps: ["Add a benchmark for 10,000 records", "Update the index when records change"],
  risks: ["Index updates may become stale"], dependencies: [],
  validationPlan: ["Verify result equivalence", "Measure P95 latency against 100ms acceptance target"],
};
const source: SearchSource = { title: "Official algorithm guide", url: "https://example.org/search-guide", description: "Index construction and lookup complexity" };

test("Guider starts searches concurrently, deduplicates sources and uses the isolated workspace", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const searches: { directory: string; query: string; limit?: number }[] = [];
  const requests: AgentRequest[] = [];
  const runtime: AgentRuntime = {
    async search(request) { searches.push(request); await gate; return [source]; },
    async run(request) { requests.push(request); return { sessionId: "research-session", text: JSON.stringify(guidance) }; },
  };
  const worktree = "/tmp/isolated-worktree";
  const pending = new ProblemSolvingGuider(runtime).guide(project, task, worktree);
  try {
    assert.equal(searches.length, 2, "Both searches should begin before a result is available");
    assert.equal(requests.length, 0, "Plan synthesis waits for the search results");
  } finally { release(); }
  const result = await pending;
  assert.deepEqual(result.sources, [source]);
  assert.deepEqual(result.searchErrors, []);
  assert.deepEqual(result.guidance, guidance);
  assert.ok(searches.every(search => search.directory === worktree && search.limit === 5));
  assert.equal(requests[0]!.directory, worktree);
  assert.equal(requests[0]!.mode, "research");
  assert.deepEqual(requests[0]!.model, project.models.guider);
  assert.ok(requests[0]!.prompt.includes(task.questions[0]!.answer!));
  assert.ok(requests[0]!.prompt.includes(task.acceptanceCriteria[0]!));
});

test("Guider records failed searches while retaining useful results and a plan", async () => {
  let searchCount = 0;
  let synthesis: AgentRequest | undefined;
  const runtime: AgentRuntime = {
    async search() { if (++searchCount === 1) throw new Error("search provider unavailable"); return [source]; },
    async run(request) { synthesis = request; return { sessionId: "research", text: JSON.stringify(guidance) }; },
  };
  const result = await new ProblemSolvingGuider(runtime).guide(project, task, "/tmp/worktree");
  assert.deepEqual(result.sources, [source]);
  assert.equal(result.searchErrors.length, 1);
  assert.match(result.searchErrors[0]!, /search provider unavailable/);
  assert.match(result.searchErrors[0]!, /official documentation/);
  assert.ok(synthesis!.prompt.includes("search provider unavailable"));
  assert.ok(synthesis!.prompt.includes(source.url));
  assert.deepEqual(result.guidance.integrationSteps, guidance.integrationSteps);
});

test("Guider still synthesizes conservative guidance when all searches fail", async () => {
  let calls = 0;
  let prompt = "";
  const runtime: AgentRuntime = {
    async search() { throw new Error("offline"); },
    async run(request) { calls++; prompt = request.prompt; return { sessionId: "fallback", text: JSON.stringify({ ...guidance, summary: "Search unavailable; benchmark the existing implementation first" }) }; },
  };
  const result = await new ProblemSolvingGuider(runtime).guide(project, task, "/tmp/worktree");
  assert.equal(calls, 1);
  assert.equal(result.searchErrors.length, 2);
  assert.deepEqual(result.sources, []);
  assert.match(result.guidance.summary, /Search unavailable/);
  assert.match(prompt, /If searches fail or find nothing, say so/);
  assert.match(prompt, /Do not modify files or run shell commands/);
});

test("Guider rejects output without integration steps or acceptance-oriented validation", async t => {
  for (const invalid of [{ integrationSteps: [] }, { validationPlan: [] }]) await t.test(JSON.stringify(invalid), async () => {
    const runtime: AgentRuntime = {
      async search() { return []; },
      async run() { return { sessionId: "invalid-plan", text: JSON.stringify({ ...guidance, ...invalid }) }; },
    };
    await assert.rejects(new ProblemSolvingGuider(runtime).guide(project, task, "/tmp/worktree"));
  });
});
