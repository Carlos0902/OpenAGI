import { randomUUID } from "node:crypto";
import type { ConversationIO } from "./terminal.js";
import type { WebMessage, WebPrompt, PromptChoice } from "./web-types.js";
import type { WorkflowStage } from "./runtime.js";
import type { ProjectInput, ProjectInputQueue } from "./input-queue.js";

export class BrowserConversation implements ConversationIO {
  readonly messages: WebMessage[] = [];
  prompt?: WebPrompt;
  failure?: string;
  stage?: WorkflowStage;
  private waiting?: (answer: string | null) => void;
  private secrets = new Set<string>();
  private closed = false;
  private inputs: string[] = [];
  private currentInput?: ProjectInput;
  constructor(private signal: AbortSignal, private queue?: ProjectInputQueue) {
    signal.addEventListener("abort", () => this.close(), { once: true });
    for (const entry of queue?.entries ?? []) this.messages.push({ ...entry, role: "user" });
  }
  hide(keys: string[]) { keys.filter(Boolean).forEach(key => this.secrets.add(key)); }
  redact(text: string) { return [...this.secrets].reduce((value, key) => value.split(key).join("[hidden]"), text); }
  write(text: string) { if (!this.closed && !this.signal.aborted) this.append("assistant", this.redact(text)); }
  private append(role: WebMessage["role"], text: string) {
    this.messages.push({ id: randomUUID(), role, text, at: new Date().toISOString() });
    if (this.messages.length > 2_000) this.messages.splice(0, this.messages.length - 2_000);
  }
  error(text: string) { this.failure = this.redact(text); }
  activity(stage: WorkflowStage) { if (!this.closed && !this.signal.aborted) this.stage = stage; }
  get queued() { return this.queue?.count ?? this.inputs.length; }
  get inputID() { return this.currentInput?.id; }
  enqueue(text: string): void | Promise<void> {
    if (this.closed || this.signal.aborted) throw new Error("交互已结束，请重新开始后再提交。");
    if (!text.trim()) throw new Error("请输入消息。");
    if (text.length > 16_000) throw new Error("消息过长，请控制在 16000 个字符以内。");
    if (this.queue) return this.queue.enqueue(text).then(entry => {
      if (!this.closed && !this.signal.aborted) this.messages.push({ ...entry, text: this.redact(entry.text), role: "user" });
    });
    if (this.inputs.length >= 32) throw new Error("待处理消息已满，请等待当前步骤完成后再提交。");
    this.inputs.push(text);
    this.append("user", this.redact(text));
  }
  takeInput(): string | undefined {
    if (this.closed || this.signal.aborted) return undefined;
    if (this.queue) {
      if (this.currentInput) return undefined;
      this.currentInput = this.queue.peek();
      return this.currentInput?.text;
    }
    return this.inputs.shift();
  }
  async completeInput(): Promise<void> {
    if (!this.currentInput || !this.queue) return;
    await this.queue.complete(this.currentInput.id);
    this.currentInput = undefined;
  }
  ask(text: string, choices?: PromptChoice[]) { return this.wait(text, false, choices); }
  secret(text: string) { return this.wait(text, true); }
  private wait(text: string, secret: boolean, choices?: PromptChoice[]): Promise<string | null> {
    if (this.closed || this.signal.aborted) return Promise.resolve(null);
    if (this.waiting) throw new Error("已有问题等待回答");
    if (!secret) {
      const input = this.takeInput();
      if (input !== undefined) { this.failure = undefined; return Promise.resolve(input); }
    }
    this.prompt = { id: randomUUID(), text: this.redact(text.replace(/\n?>\s*$/, "").trim()), secret, ...(choices ? { choices } : {}) };
    return new Promise(resolve => { this.waiting = resolve; });
  }
  answer(id: string, text: string) {
    if (!this.waiting || this.prompt?.id !== id) throw new Error( "这个问题已结束，请刷新后再回答。");
    if (this.prompt.secret) { this.hide([text.trim()]); this.append("user", "已提交密钥（隐藏）"); }
    else this.append("user", this.redact(text || "确认"));
    const waiting = this.waiting; this.waiting = undefined; this.prompt = undefined; this.failure = undefined; this.currentInput = undefined; waiting(text);
  }
  close() { this.closed = true; this.inputs = []; this.currentInput = undefined; const waiting = this.waiting; this.waiting = undefined; this.prompt = undefined; this.stage = undefined; waiting?.(null); }
}
