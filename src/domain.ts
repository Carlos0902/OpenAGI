import { z } from "zod";
import { ClarificationPolicy } from "./clarification.js";

export const moduleNames = ["function-finder", "performance-optimizer", "ui-designer"] as const;
export const ModuleName = z.enum(moduleNames);
export const Model = z.object({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional() });
export const Check = z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()), timeoutMs: z.number().int().min(100).max(3_600_000) });
export const Question = z.object({ id: z.string().min(1), question: z.string().min(1), answer: z.string().min(1).optional(),
  blocking: z.boolean().optional(), defaultDecision: z.string().min(1).optional(), decisionRequiredProbability: z.number().min(0).max(1).optional(),
});
export const Evidence = z.object({ location: z.string().min(1), observation: z.string().min(1) });
export const Proposal = z.object({
  title: z.string().min(1), description: z.string().min(1), evidence: z.array(Evidence).min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).refine(xs => new Set(xs).size === xs.length, "Acceptance criteria must be unique"),
  questions: z.array(Question).refine(xs => new Set(xs.map(x => x.id)).size === xs.length, "Question IDs must be unique"),
  assumptions: z.array(z.string().min(1)).optional(),
});
export const Discovery = z.object({ proposals: z.array(Proposal).max(12) });
const Score = z.number().min(0).max(5);
export const Assessment = z.object({
  necessity: Score, value: Score, urgency: Score, feasibility: Score, requirementClarity: Score,
  userDecisionRequired: z.boolean(), rationale: z.string().min(1),
  archiveReason: z.string().optional(), reevaluateWhen: z.array(z.string().min(1)).default([]),
  jev: z.object({ source: z.literal("typesafe"), model: z.string(), answers: z.record(z.string(), z.unknown()), clarification: ClarificationPolicy.optional() }).optional(),
});
export const Judgement = z.object({ groups: z.array(z.object({
  candidateIds: z.array(z.string().min(1)).min(1), proposal: Proposal, assessment: Assessment,
})) });
export const Source = z.object({ title: z.string(), url: z.url(), description: z.string(), publishedAt: z.number().optional() });
export const Guidance = z.object({
  summary: z.string().min(1), approach: z.string().min(1), alternatives: z.array(z.string()),
  integrationSteps: z.array(z.string().min(1)).min(1), risks: z.array(z.string()),
  dependencies: z.array(z.object({ name: z.string(), url: z.url(), license: z.string(), reason: z.string() })),
  validationPlan: z.array(z.string().min(1)).min(1),
});
export const Acceptance = z.object({
  criteria: z.array(z.object({ criterion: z.string(), passed: z.boolean(), evidence: z.string().min(1), kind: z.enum(["requirement", "measurement"]).default("requirement") })).min(1),
  summary: z.string().min(1), rawSummary: z.string().optional(),
});
export const WorkspaceInfo = z.object({ directory: z.string(), branch: z.string(), baseBranch: z.string(), baseCommit: z.string(), headCommit: z.string().optional() });
export const CheckOutcome = z.object({ name: z.string(), ok: z.boolean(), exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean() });
export const Run = z.object({
  id: z.string(), createdAt: z.string(), status: z.enum(["preparing", "researching", "executing", "validating", "failed", "validated", "merged"]),
  workspace: WorkspaceInfo.optional(), workerSessionId: z.string().optional(), workerCompleted: z.boolean().default(false), validatorSessionId: z.string().optional(),
  validatedHead: z.string().optional(), guidance: Guidance.optional(), sources: z.array(Source).default([]),
  searchErrors: z.array(z.string()).default([]), checks: z.array(CheckOutcome).default([]), acceptance: Acceptance.optional(),
  error: z.string().optional(),
});
export const Task = Proposal.extend({
  id: z.string(), modules: z.array(ModuleName), createdAt: z.string(), updatedAt: z.string(),
  status: z.enum(["awaiting_user", "ready", "archived", "running", "failed", "validated", "merged"]),
  assessment: Assessment, priority: z.number(), runs: z.array(Run),
});
export const ProjectConfig = z.object({
  name: z.string().min(1), directory: z.string().min(1),
  modules: z.array(ModuleName).min(1).refine(xs => new Set(xs).size === xs.length, "Modules must be unique"),
  context: z.object({ goal: z.string().min(1), audience: z.string().default("Unspecified; ask the user when relevant"), constraints: z.string().default("Unspecified; ask the user when relevant"), notes: z.array(z.string()).optional() }),
  opencode: z.object({
    url: z.url().default("http://127.0.0.1:4096").refine(value => {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, "Use an HTTP(S) server URL without credentials/query/fragment; credentials belong in environment variables"),
    timeoutMs: z.number().int().positive().default(900_000),
  }),
  models: z.object({ discovery: Model.optional(), collector: Model.optional(), guider: Model.optional(), worker: Model.optional(), validator: Model.optional(), dialogue: Model.optional() }).default({}),
  jev: z.object({ type: z.enum(["llm", "http", "typesafe"]), model: Model.optional(), url: z.string().optional(), repairAttempts: z.number().int().min(0).max(3).default(1) }).optional(),
  validation: z.object({ checks: z.array(Check), requireChecks: z.boolean().default(true) }),
  archiveNecessityBelow: z.number().int().min(0).max(5).default(2),
  clarification: ClarificationPolicy.optional(),
});
export const State = z.object({
  version: z.literal(1), project: ProjectConfig, tasks: z.array(Task),
  discoveryErrors: z.array(z.object({ module: ModuleName, message: z.string(), at: z.string() })).default([]),
  awaitingInput: z.boolean().optional(),
  delivery: z.object({ goal: z.string(), taskIDs: z.array(z.string()), createdAt: z.string(), source: z.string().optional(), markdown: z.string() }).optional(),
  conversationStartedAt: z.string().optional(),
  conversation: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string(), at: z.string(), sourceInputID: z.string().optional() })).optional(),
  discoveryPending: z.object({
    createdAt: z.string(), status: z.enum(["collecting", "failed"]),
    contextKey: z.string().optional(),
    candidates: z.array(z.object({ id: z.string(), modules: z.array(ModuleName), proposal: Proposal, existing: Task.optional() })),
    replies: z.array(z.object({ sessionId: z.string(), text: z.string(), at: z.string(), error: z.string().optional() })),
    error: z.string().optional(),
  }).optional(),
  collectorReplies: z.array(z.object({ sessionId: z.string(), text: z.string(), at: z.string(), error: z.string().optional() })).optional(),
  discoveryHistory: z.array(z.object({
    createdAt: z.string(), result: z.enum(["collected", "superseded"]),
    candidates: z.array(z.object({ id: z.string(), modules: z.array(ModuleName), proposal: Proposal })),
    replies: z.array(z.object({ sessionId: z.string(), text: z.string(), at: z.string(), error: z.string().optional() })),
  })).optional(),
});
export type ModuleName = z.infer<typeof ModuleName>;
export type Proposal = z.infer<typeof Proposal>;
export type Assessment = z.infer<typeof Assessment>;
export type Task = z.infer<typeof Task>;
export type Run = z.infer<typeof Run>;
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type State = z.infer<typeof State>;
export type Guidance = z.infer<typeof Guidance>;

export function parseOutput<T>(schema: z.ZodType<T>, text: string): T {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return schema.parse(JSON.parse(fenced?.[1] ?? trimmed));
}

export function outputInstruction(schema: z.ZodType): string {
  return `Return ONLY a JSON object matching this schema, with no prose or markdown. Do not use a form/question tool; include user questions in the JSON.\n${JSON.stringify(z.toJSONSchema(schema))}`;
}

export function priority(assessment: Assessment): number {
  return Math.round((assessment.necessity * 0.3 + assessment.value * 0.25 + assessment.urgency * 0.2 + assessment.feasibility * 0.15 + assessment.requirementClarity * 0.1) * 20);
}
