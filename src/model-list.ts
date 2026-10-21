import { z } from "zod";
import { networkFetch } from "./network.js";

export type ProviderType = "openai-compatible" | "openai" | "anthropic" | "google";
export interface AvailableModel { id: string; name: string; contextWindow?: number; maxOutputTokens?: number }
const Row = z.object({ id: z.string().optional(), name: z.string().optional(), display_name: z.string().nullish(), displayName: z.string().nullish(), inputTokenLimit: z.number().optional(), outputTokenLimit: z.number().optional(), context_window: z.number().nullish(), supportedGenerationMethods: z.array(z.string()).optional() }).passthrough();

export async function availableModels(type: ProviderType, baseURL: string, apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch, extraHeaders: Record<string, string> = {}): Promise<AvailableModel[]> {
  const base = new URL(baseURL);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("请填写不含凭据或查询串的 HTTP(S) API 基础地址");
  const defaults: Record<string, string> = type === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : type === "google" ? { "x-goog-api-key": apiKey } : apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const headers = new Headers(defaults);
  Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
  const url = new URL(baseURL.replace(/\/$/, "") + "/models");
  const models = new Map<string, AvailableModel>(); const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const timeout = AbortSignal.timeout(20_000);
    const response = await networkFetch(url, { headers, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout }, "Provider 模型列表", fetcher);
    if (!response.ok) throw new Error(`获取可用模型失败（HTTP ${response.status}）。请检查 provider 地址、API key 和模型列表权限。`);
    const body = z.object({ data: z.array(Row).optional(), models: z.array(Row).optional(), has_more: z.boolean().optional(), last_id: z.string().optional(), nextPageToken: z.string().optional() }).parse(await response.json());
    const rows = type === "google" ? body.models : body.data;
    if (!rows) throw new Error("provider 返回了无法识别的模型列表；不会编造模型选项。");
    for (const row of rows) {
      if (type === "google" && !row.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = type === "google" ? row.name?.replace(/^models\//, "") : row.id;
      if (!id) continue;
      models.set(id, { id, name: row.display_name ?? row.displayName ?? id, contextWindow: row.inputTokenLimit ?? row.context_window ?? undefined, maxOutputTokens: row.outputTokenLimit });
    }
    const token = type === "google" ? body.nextPageToken : body.has_more ? body.last_id ?? rows.at(-1)?.id : undefined;
    if (!token) {
      if (!models.size) throw new Error("该账号没有返回可用的文本生成模型，请确认权限。");
      return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    if (seen.has(token)) throw new Error("provider 模型列表分页重复，已停止读取。");
    seen.add(token); url.searchParams.set(type === "google" ? "pageToken" : "after_id", token);
  }
  throw new Error("模型列表超过分页上限，无法完整读取。");
}

/** Explicit custom model IDs are configuration, rather than claims about a remote catalog. */
export async function configuredModels(provider: { type: ProviderType; baseURL: string; headers?: Record<string, string>; models?: readonly { id: string; name?: string; contextWindow?: number; maxOutputTokens?: number }[] }, apiKey: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<AvailableModel[]> {
  if (provider.models?.length) return provider.models.map(model => ({ ...model, name: model.name ?? model.id }));
  return availableModels(provider.type, provider.baseURL, apiKey, signal, fetcher, provider.headers);
}
