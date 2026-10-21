import type { AgentRuntime, AgentRequest, AgentReply, WorkflowStage } from "./runtime.js";
import { backendProviderId, type LoadedSettings } from "./settings.js";
import { typesafeJudgement } from "./typesafe.js";
import { withinProject } from "./boundary.js";
import type { UsageTracker } from "./usage.js";

export class ConfiguredRuntime implements AgentRuntime {
  constructor(private delegate: AgentRuntime, private loaded: LoadedSettings, private root: string, private signal?: AbortSignal, private typesafeFetch: typeof fetch = fetch, private onActivity?: (stage: WorkflowStage) => void, private usage?: { tracker: UsageTracker; server?: { url: string; password: string } }) {}
  async run(request: AgentRequest): Promise<AgentReply> {
    try { return await this.execute(request); }
    finally { if (this.usage?.server) await this.usage.tracker.sync(this.usage.server); }
  }
  private async execute(request: AgentRequest): Promise<AgentReply> {
    await withinProject(this.root, request.directory);
    if (request.purpose === "collector") {
      const heavy = this.loaded.settings.models.heavy;
      return typesafeJudgement(request, this.delegate, { ...heavy, providerID: backendProviderId(heavy.providerID) }, this.loaded.jevKey, this.signal, this.typesafeFetch, () => this.onActivity?.("assessing"), this.usage ? (model, usage) => this.usage!.tracker.recordJev(model, usage) : undefined);
    }
    if (!request.model) throw new Error("缺少 OpenAGI 角色模型配置；不会使用 OpenCode 默认模型。");
    if (!this.loaded.settings.providers[request.model.providerID]) throw new Error("该模型的提供方未在当前 OpenAGI 配置中声明。");
    return this.delegate.run({ ...request, model: { ...request.model, providerID: backendProviderId(request.model.providerID) } });
  }
  async search(request: { directory: string; query: string; limit?: number }) {
    await withinProject(this.root, request.directory);
    return this.delegate.search(request);
  }
}
