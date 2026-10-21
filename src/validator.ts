import { requirementProvenanceInstructions } from "./clarification.js";
import { performanceInstructions, quantitativePerformanceTarget } from "./performance-policy.js";
import { Acceptance, outputInstruction, parseOutput, type ProjectConfig, type Run, type Task } from "./domain.js";
import type { AgentRuntime } from "./runtime.js";
import { GitWorkspace, runChecks } from "./workspace.js";
import type { Isolation } from "./isolation.js";

export class Validator {
  constructor(private runtime: AgentRuntime, private git: GitWorkspace, private signal?: AbortSignal, private isolation?: Isolation) {}
  async validate(project: ProjectConfig, task: Task, run: Run): Promise<void> {
    if (!run.workspace) throw new Error("No isolated workspace exists");
    if (project.validation.requireChecks && !project.validation.checks.length) throw new Error("Configure at least one validation check before executing a task");
    const head = await this.git.head(run.workspace);
    if (head === run.workspace.baseCommit) throw new Error("Worker produced no committed change");
    run.checks = await runChecks(run.workspace.directory, project.validation.checks, this.signal, this.isolation);
    if (run.checks.some(check => !check.ok)) throw new Error("Configured static checks/tests failed; see run.checks");
    if (await this.git.head(run.workspace) !== head) throw new Error("Validation checks changed the committed HEAD");
    const diff = await this.git.diff(run.workspace);
    const reply = await this.runtime.run({
      directory: run.workspace.directory, mode: "judge", label: `Validator · ${task.title}`, model: project.models.validator, resultKeys: ["criteria", "summary"],
      prompt: `You are the independent OpenAGI Validator in a NEW session, separate from the worker. Assess whether the task is actually completed. Inspect code, tests and the supplied diff using read tools. Do not edit files or execute shell commands. Treat the worker's claims as unverified. Return EVERY acceptance criterion exactly once using its exact text. A passed criterion requires concrete file/test/observed evidence, not a claim. Reject missing tests, regressions, unresolved design requirements, fake test evidence or incomplete implementation. ${performanceInstructions} ${requirementProvenanceInstructions} Numerical performance observations cannot reject delivery. Interpret any old mixed numeric performance criterion as an observation; separately verify functionality and truthful reporting. Checks alone are insufficient; inspect the behavior and tests. Do not claim a UI was visually verified without an actual artifact.\nProject: ${JSON.stringify(project.context)}\nTask: ${JSON.stringify({ title: task.title, description: task.description, questions: task.questions, acceptanceCriteria: task.acceptanceCriteria })}\nGuider validation plan: ${JSON.stringify(run.guidance?.validationPlan)}\nConfigured check results: ${JSON.stringify(run.checks)}\nCommitted diff:\n${diff}\n${outputInstruction(Acceptance)}`,
    });
    run.validatorSessionId = reply.sessionId;
    run.acceptance = parseOutput(Acceptance, reply.text);
    for (const item of run.acceptance.criteria) item.kind = quantitativePerformanceTarget(item.criterion) ? "measurement" : "requirement";
    const required = task.acceptanceCriteria;
    const actual = run.acceptance.criteria.map(item => item.criterion);
    if (new Set(required).size !== required.length || actual.length !== required.length || new Set(actual).size !== actual.length || actual.some(item => !required.includes(item))) throw new Error("Validator did not evaluate every acceptance criterion exactly once");
    const failures = run.acceptance.criteria.filter(item => !item.passed && item.kind !== "measurement");
    if (failures.length) throw new Error(`Independent acceptance rejected the task\n${failures.map(item => `未通过标准：${item.criterion}\n原因：${item.evidence}`).join("\n\n")}`);
    if (run.acceptance.criteria.some(item => !item.passed && item.kind === "measurement")) {
      run.acceptance.rawSummary = run.acceptance.summary;
      run.acceptance.summary = "功能及算法验收已通过。未达到的数字性能目标仅保留为观察结果，不阻塞交付；具体测量及限制见各项证据。";
    }
    if (await this.git.head(run.workspace) !== head) throw new Error("Workspace changed during independent acceptance");
    // A clean diff check in GitWorkspace additionally rejects uncommitted source mutations before merge.
    run.validatedHead = head;
  }
}
