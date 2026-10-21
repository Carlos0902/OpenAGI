export type ModelRef = { providerID: string; modelID: string; variant?: string };
export type RunMode = "observe" | "research" | "judge" | "build";
export type WorkflowStage = "discovering" | "collecting" | "assessing" | "planning" | "preparing" | "researching" | "implementing" | "validating" | "merging" | "discussing" | "handoff";
import type { ClarificationPolicy } from "./clarification.js";
export interface AgentRequest {
  directory: string;
  prompt: string;
  mode: RunMode;
  model?: ModelRef;
  sessionId?: string;
  label?: string;
  /** Structured orchestration output remains available in a folded native disclosure. */
  resultKeys?: string[];
  purpose?: "collector";
  evaluation?: { context: unknown; candidates: unknown[]; archiveNecessityBelow: number; reopen: boolean; clarification?: ClarificationPolicy; repair?: { reply: string; error: string } };
}
export interface AgentReply { sessionId: string; text: string }
export interface SearchSource { title: string; url: string; description: string; publishedAt?: number }
/** OpenAGI owns decisions and lifecycle; OpenCode owns models, tool use and code execution. */
export interface AgentRuntime {
  run(request: AgentRequest): Promise<AgentReply>;
  search(request: { directory: string; query: string; limit?: number }): Promise<SearchSource[]>;
}
