export interface WebMessage { id: string; role: "assistant" | "user" | "system"; text: string; at: string }
export interface PromptChoice { value: string; label: string; description?: string }
export interface WebPrompt { id: string; text: string; secret: boolean; choices?: PromptChoice[] }
export interface WebTask {
  id: string; title: string; description: string; status: string; priority: number;
  acceptanceCriteria: string[]; rationale: string;
  run?: { status: string; branch?: string; sessionId?: string; error?: string; checks: { name: string; ok: boolean }[]; acceptance?: string; acceptanceDetails?: { criterion: string; passed: boolean; evidence: string; kind: "requirement" | "measurement" }[] };
}
export interface WebSnapshot {
  directory: string; project?: { name: string; summary: string; modules: string[] };
  config?: { heavy: string; light: string; providers: { id: string; type: string; baseURL: string }[] };
  phase: "idle" | "running" | "configuring" | "stopping";
  suggestedSummary?: string;
  messages: WebMessage[]; prompt?: WebPrompt; tasks: WebTask[];
}
