import { performanceInstructions } from "./performance-policy.js";
import { clarificationInstructions, isBlockingQuestion } from "./clarification.js";
import { randomUUID } from "node:crypto";
import { Collector, Tutor, candidateFromTask, type CollectorAttempt } from "./tutor.js";
import { ProblemSolvingGuider } from "./guider.js";
import { Validator } from "./validator.js";
import { ProjectStore } from "./store.js";
import { GitWorkspace } from "./workspace.js";
import { type Run, type State, type Task } from "./domain.js";
import type { AgentRuntime, WorkflowStage } from "./runtime.js";
import type { Isolation } from "./isolation.js";

export class OpenAGI {
  constructor(readonly store: ProjectStore, private runtime: AgentRuntime, private progress: (message: string, stage?: WorkflowStage) => void = () => {}, private signal?: AbortSignal, private isolation?: Isolation) {}
  setIsolation(isolation: Isolation): void { this.isolation = isolation; }
  async saveBaseline(): Promise<string> {
    return new GitWorkspace(this.store.directory, undefined, this.isolation, this.signal).saveBaseline();
  }
  private async audit(state: State, record: CollectorAttempt): Promise<void> {
    const replies = state.collectorReplies ??= [];
    const prior = replies.find(item => item.sessionId === record.sessionId && item.at === record.at);
    if (prior) Object.assign(prior, record); else replies.push(record);
    await this.store.write(state);
  }
  private archiveDiscovery(state: State, result: "collected" | "superseded"): void {
    const pending = state.discoveryPending;
    if (!pending) return;
    (state.discoveryHistory ??= []).push({ createdAt: pending.createdAt, result, candidates: pending.candidates.map(({ existing: _existing, ...candidate }) => candidate), replies: pending.replies });
    delete state.discoveryPending;
  }
  private find(state: State, id: string): Task {
    const matches = state.tasks.filter(task => task.id === id || task.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? "Task ID is ambiguous" : `Task not found: ${id}`);
    return matches[0]!;
  }
  async discover(): Promise<State> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const contextKey = JSON.stringify({ context: state.project.context, modules: state.project.modules });
      if (state.discoveryPending?.contextKey && state.discoveryPending.contextKey !== contextKey) this.archiveDiscovery(state, "superseded");
      if (!state.discoveryPending) {
        this.progress(`Running Tutor modules in parallel: ${state.project.modules.join(", ")}`, "discovering");
        const discovery = await new Tutor(this.runtime).discover(state.project);
        state.discoveryErrors = discovery.errors;
        await this.store.write(state);
        const terminalTitles = new Set(state.tasks.filter(task => ["running", "failed", "validated", "merged"].includes(task.status)).map(task => task.title.trim().toLowerCase()));
        const fresh = discovery.candidates.filter(candidate => !terminalTitles.has(candidate.proposal.title.trim().toLowerCase()));
        if (!fresh.length) return state;
        const existing = state.tasks.filter(task => ["awaiting_user", "ready", "archived"].includes(task.status));
        state.discoveryPending = { createdAt: new Date().toISOString(), status: "collecting", contextKey, candidates: [...existing.map(candidateFromTask), ...fresh], replies: [] };
        await this.store.write(state);
      } else this.progress("Collector is retrying the saved candidates; Tutor will not run again", "collecting");
      const pending = state.discoveryPending;
      pending.status = "collecting"; delete pending.error;
      this.progress("Collector is consolidating proposals and assessing priority", "collecting");
      try {
        const tasks = await new Collector(this.runtime).collect(state.project, pending.candidates, false, async record => {
          const previous = pending.replies.find(item => item.sessionId === record.sessionId && item.at === record.at);
          if (previous) Object.assign(previous, record); else pending.replies.push(record);
          await this.audit(state, record);
        });
        const replaced = new Set(pending.candidates.flatMap(candidate => candidate.existing ? [candidate.existing.id] : []));
        state.tasks = [...state.tasks.filter(task => !replaced.has(task.id)), ...tasks];
        this.archiveDiscovery(state, "collected");
        await this.store.write(state); return state;
      } catch (error) {
        pending.status = "failed"; pending.error = String(error);
        await this.store.write(state); throw error;
      }
    });
  }
  async answer(id: string, questionId: string, answer: string): Promise<Task> {
    if (!answer.trim()) throw new Error("Answer cannot be empty");
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const task = this.find(state, id);
      if (task.status !== "awaiting_user") throw new Error("Only tasks awaiting a user decision can be answered");
      const question = task.questions.find(item => item.id === questionId);
      if (!question) throw new Error(`Question not found: ${questionId}`);
      question.answer = answer.trim();
      task.updatedAt = new Date().toISOString();
      await this.store.write(state);
      if (task.questions.some(isBlockingQuestion)) return task;
      this.progress("Collector is refining requirements using your answers", "collecting");
      const [refined] = await new Collector(this.runtime).collect(state.project, [candidateFromTask(task)], true, record => this.audit(state, record));
      if (!refined) throw new Error("Collector returned no task");
      state.tasks[state.tasks.indexOf(task)] = refined;
      await this.store.write(state);
      return refined;
    });
  }
  async reevaluate(id: string): Promise<Task> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const task = this.find(state, id);
      if (!["archived", "ready", "awaiting_user"].includes(task.status)) throw new Error("Cannot reassess an executing or completed task");
      const [refined] = await new Collector(this.runtime).collect(state.project, [candidateFromTask(task)], true, record => this.audit(state, record));
      if (!refined) throw new Error("Collector returned no task");
      state.tasks[state.tasks.indexOf(task)] = refined;
      await this.store.write(state);
      return refined;
    });
  }
  async archive(id: string, reason: string): Promise<void> {
    await this.store.withLock(async () => {
      const state = await this.store.read(); const task = this.find(state, id);
      if (!["ready", "awaiting_user"].includes(task.status)) throw new Error("Only unstarted proposals can be deferred");
      task.status = "archived"; task.updatedAt = new Date().toISOString();
      task.assessment.archiveReason = reason;
      task.assessment.reevaluateWhen = ["用户改变优先级或明确要求重新考虑这项任务"];
      await this.store.write(state);
    });
  }
  async execute(id: string, options: { resume?: boolean; retry?: boolean; repair?: boolean } = {}): Promise<Task> {
    return this.store.withLock(async () => {
      const state = await this.store.read();
      const task = this.find(state, id);
      if (state.project.validation.requireChecks && !state.project.validation.checks.length) throw new Error("Configure validation checks before running Worker (edit .openagi/state.json project.validation.checks)");
      let run: Run;
      if (options.resume) {
        const latest = task.runs.at(-1);
        if (!latest || !["running", "failed"].includes(task.status)) throw new Error("No interrupted/failed run to resume");
        run = latest;
      } else {
        if (task.status !== "ready" && !(options.retry && task.status === "failed")) throw new Error("Task must be ready; answer its questions first, or use --retry on a failed task");
        run = { id: randomUUID(), createdAt: new Date().toISOString(), status: "preparing", workerCompleted: false, sources: [], searchErrors: [], checks: [] };
        task.runs.push(run);
      }
      const previousFailure = run.error;
      if (options.repair) run.workerCompleted = false;
      task.status = "running";
      delete run.error;
      await this.store.write(state);
      const git = new GitWorkspace(state.project.directory, undefined, this.isolation, this.signal);
      try {
        this.signal?.throwIfAborted();
        if (!run.workspace) {
          this.progress("Creating an isolated task branch and Worktree", "preparing");
          run.workspace = await git.create(run.id);
          await this.store.write(state);
        }
        if (!run.guidance) {
          run.status = "researching";
          await this.store.write(state);
          this.progress("Problem Solving Guider is researching sources and integration steps", "researching");
          Object.assign(run, await new ProblemSolvingGuider(this.runtime).guide(state.project, task, run.workspace.directory));
          await this.store.write(state);
        }
        if (!run.workerCompleted) {
          run.status = "executing";
          await this.store.write(state);
          this.progress("OpenCode's original Worker is implementing the selected task", "implementing");
          try {
            const reply = await this.runtime.run({
              directory: run.workspace.directory, mode: "build", label: `Worker · ${task.title}`, model: state.project.models.worker, sessionId: run.workerSessionId,
              prompt: `${run.workerSessionId ? "Continue the existing task after resolving any pending upstream interaction." : "Implement this selected OpenAGI task."} Work only inside this isolated directory: ${run.workspace.directory}. Reuse existing project code and tools. Follow the user decisions and acceptance criteria. ${clarificationInstructions} ${performanceInstructions} OpenAGI owns technical prerequisites and task ordering: if an internal upstream version or reversible implementation step is missing, inspect the actual repository and implement the minimal required prerequisite inside this task workspace. Preserve and identify real source snapshots for comparison; never pretend an archived task was delivered. Do not ask the human to supply OpenAGI's own technical output or merely authorize ordinary reversible prerequisites. Preserve the exact acceptance criteria, run their measurements and report a concrete blocker if they truly cannot be satisfied. Add meaningful regression/acceptance tests and execute relevant configured checks. Update user-facing project documentation with actual prerequisites, launch instructions, basic operation and known limitations in the user's language. Verify instructions against the implementation; do not invent commands, ports, credentials or claim a service is already running. Read primary source documentation before adding recommended dependencies; inspect license and compatibility, use pinned dependencies, and reuse existing libraries where appropriate. Do not commit, change branches, merge, remove the worktree, or modify OpenAGI's .openagi state; the orchestrator owns Git and acceptance.\nTask: ${JSON.stringify(task)}\nImplementation guidance: ${JSON.stringify(run.guidance)}\nResearch sources: ${JSON.stringify(run.sources)}\nConfigured checks: ${JSON.stringify(state.project.validation.checks)}${options.repair ? `\nIndependent validation rejected the previous implementation. Fix the actual problem; do not weaken or bypass configured checks or acceptance criteria.\nPrevious failure: ${previousFailure}\nCheck evidence: ${JSON.stringify(run.checks)}\nAcceptance evidence: ${JSON.stringify(run.acceptance)}` : ""}`,
            });
            run.workerSessionId = reply.sessionId;
            run.workerCompleted = true;
          } catch (error) {
            const sessionId = (error as { sessionId?: unknown }).sessionId;
            if (typeof sessionId === "string") run.workerSessionId = sessionId;
            throw error;
          }
          await this.store.write(state);
        }
        await this.finishValidation(state, task, run, git);
      } catch (error) {
        task.status = "failed"; run.status = "failed"; run.error = String(error);
        task.updatedAt = new Date().toISOString();
        await this.store.write(state);
        throw error;
      }
      return task;
    });
  }
  private async finishValidation(state: State, task: Task, run: Run, git: GitWorkspace): Promise<void> {
    if (!run.workspace) throw new Error("No isolated workspace exists");
    // Any previous acceptance is invalid once validation starts again.
    delete run.validatedHead; delete run.acceptance; delete run.validatorSessionId; delete run.error;
    run.checks = []; run.status = "validating";
    run.workspace.headCommit = await git.checkpoint(run.workspace, task.title);
    await this.store.write(state);
    this.progress("Running configured checks and independent acceptance", "validating");
    await new Validator(this.runtime, git, this.signal, this.isolation).validate(state.project, task, run);
    task.status = "validated"; run.status = "validated";
    task.updatedAt = new Date().toISOString();
    await this.store.write(state);
  }
  async validate(id: string): Promise<Task> {
    return this.store.withLock(async () => {
      const state = await this.store.read(); const task = this.find(state, id); const run = task.runs.at(-1);
      this.signal?.throwIfAborted();
      if (!run?.workerCompleted || !run.workspace || task.status === "merged") throw new Error("No completed Worker run to validate");
      try { await this.finishValidation(state, task, run, new GitWorkspace(state.project.directory, undefined, this.isolation, this.signal)); }
      catch (error) {
        run.status = "failed"; task.status = "failed"; run.error = String(error);
        task.updatedAt = new Date().toISOString();
        await this.store.write(state); throw error;
      }
      return task;
    });
  }
  async merge(id: string): Promise<Task> {
    return this.store.withLock(async () => {
      const state = await this.store.read(); const task = this.find(state, id); const run = task.runs.at(-1);
      if (task.status !== "validated" || run?.status !== "validated" || !run.workspace || !run.validatedHead) throw new Error("Only an independently validated task can be merged");
      this.progress("Merging the independently validated task", "merging");
      await new GitWorkspace(state.project.directory, undefined, this.isolation, this.signal).merge(run.workspace, run.validatedHead);
      task.status = "merged"; run.status = "merged"; task.updatedAt = new Date().toISOString();
      await this.store.write(state);
      return task;
    });
  }
  async rebase(id: string): Promise<Task> {
    return this.store.withLock(async () => {
      const state = await this.store.read(); const task = this.find(state, id); const run = task.runs.at(-1);
      if (!run?.workerCompleted || !run.workspace || !["failed", "validated"].includes(task.status)) throw new Error("Only completed, unmerged Worker runs can be rebased");
      delete run.validatedHead; delete run.acceptance; delete run.validatorSessionId; delete run.error;
      run.status = "validating"; task.status = "running";
      await this.store.write(state);
      try {
        const git = new GitWorkspace(state.project.directory, undefined, this.isolation, this.signal);
        this.progress("Rebasing the retained task branch onto the current base; previous acceptance is invalidated", "preparing");
        run.workspace = await git.refreshBase(run.workspace);
        await this.store.write(state);
        await this.finishValidation(state, task, run, git);
      } catch (error) {
        run.status = "failed"; task.status = "failed"; run.error = String(error);
        task.updatedAt = new Date().toISOString();
        await this.store.write(state); throw error;
      }
      return task;
    });
  }
}
