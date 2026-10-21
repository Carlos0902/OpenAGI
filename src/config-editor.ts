import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Settings, settingsTemplate, ProviderModel } from "./settings.js";
import { settingsFile } from "./config-location.js";
import { configuredModels } from "./model-list.js";
import { validateTypesafeKey } from "./typesafe.js";

const HeaderEdit = z.object({ key: z.string().min(1), value: z.string() });
export const ProviderEdit = z.object({ name: z.string().optional(), models: z.array(ProviderModel).optional(), headers: z.array(HeaderEdit).optional(), id: z.string().regex(/^[a-zA-Z0-9_-]+$/), type: z.enum(["openai-compatible", "openai", "anthropic", "google"]), baseURL: z.string(), apiKey: z.string().optional(), contextWindow: z.number().int().min(1000), maxOutputTokens: z.number().int().positive() });
export type ProviderEdit = z.infer<typeof ProviderEdit>;
export const ModelSelection = z.object({ providerID: z.string(), modelID: z.string() });
export type ConfigurationView = { file: string; providers: { id: string; type: ProviderEdit["type"]; baseURL: string; contextWindow: number; maxOutputTokens: number; hasKey: boolean; name?: string; models?: z.infer<typeof ProviderModel>[]; headerNames?: string[] }[]; models: Settings["models"]; jevConfigured: boolean };
const realKey = (value?: string) => !!value && !value.includes("YOUR_");

/** Global settings editor. Keys travel only in requests; public responses never contain them. */
export class ConfigurationEditor {
  private operation: Promise<unknown> = Promise.resolve();
  constructor(private signal?: AbortSignal) {}
  private async document(): Promise<Settings> {
    try { return Settings.parse(JSON.parse(await readFile(await settingsFile("."), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Settings.parse(structuredClone(settingsTemplate)); throw new Error("无法读取全局配置，请检查配置文件的 JSON 格式和必填字段。"); }
  }
  async view(): Promise<ConfigurationView> {
    const settings = await this.document();
    return { file: await settingsFile("."), providers: Object.entries(settings.providers).filter(([, provider]) => !provider.baseURL.includes("YOUR_")).map(([id, provider]) => ({ id, type: provider.type, baseURL: provider.baseURL, contextWindow: provider.contextWindow, maxOutputTokens: provider.maxOutputTokens, name: provider.name, models: provider.models, headerNames: Object.keys(provider.headers ?? {}), hasKey: realKey(provider.apiKey) || !!provider.apiKeyEnv })), models: settings.models, jevConfigured: realKey(settings.jev.apiKey) || !!settings.jev.apiKeyEnv };
  }
  private key(provider: Settings["providers"][string]): string {
    return provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined) ?? "";
  }
  private async catalog(provider: Settings["providers"][string]) {
    return configuredModels(provider, this.key(provider), this.signal);
  }
  private async update(edit: (settings: Settings) => Promise<void>): Promise<void> {
    const operation = this.operation.catch(() => {}).then(async () => {
      const settings = await this.document(); await edit(settings); const validated = Settings.parse(settings);
      const file = await settingsFile("."); await mkdir(dirname(file), { recursive: true }); const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(validated, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
        this.signal?.throwIfAborted(); await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    });
    this.operation = operation; await operation;
  }
  async provider(input: ProviderEdit): Promise<void> {
    const edit = ProviderEdit.parse(input);
    await this.update(async settings => {
      const previous = settings.providers[edit.id];
      const { id, apiKey, headers, ...fields } = edit;
      const values = headers?.map(header => {
        const oldKey = Object.keys(previous?.headers ?? {}).find(key => key.toLowerCase() === header.key.toLowerCase());
        const value = header.value || (oldKey ? previous?.headers?.[oldKey] : undefined);
        if (!value) throw new Error("新增请求头必须填写值；已有请求头留空可保留原值。");
        return [header.key, value] as const;
      });
      if (headers && new Set(headers.map(header => header.key.toLowerCase())).size !== headers.length) throw new Error("请求头名称不能重复。");
      const provider = { ...previous, ...fields, ...(values ? { headers: Object.fromEntries(values) } : {}), ...(apiKey?.trim() ? { apiKey: apiKey.trim(), apiKeyEnv: undefined } : {}) };
      settings.providers[id] = provider;
      Settings.parse(settings);
      const models = await this.catalog(provider);
      if (!previous || previous.baseURL.includes("YOUR_")) {
        for (const role of ["heavy", "light"] as const) if (settings.models[role].modelID.includes("YOUR_")) settings.models[role] = { providerID: id, modelID: `YOUR_${role.toUpperCase()}_MODEL_ID` };
      }
      for (const [placeholderID, placeholder] of Object.entries(settings.providers)) if (placeholder.baseURL.includes("YOUR_") && !Object.values(settings.models).some(ref => ref.providerID === placeholderID)) delete settings.providers[placeholderID];
      const unavailable = Object.values(settings.models).some(ref => ref.providerID === id && !ref.modelID.includes("YOUR_") && !models.some(model => model.id === ref.modelID));
      if (unavailable) throw new Error("新提供商配置无法使用当前 Heavy 或 Light 模型；请先在模型页选择兼容的模型，或新增提供商后切换。");
    });
  }
  async remove(id: string): Promise<void> {
    await this.update(async settings => {
      if (Object.values(settings.models).some(model => model.providerID === id)) throw new Error("该提供商仍被 Heavy 或 Light 使用，请先在模型页切换。");
      delete settings.providers[id];
    });
  }
  async models(providerID: string) {
    const provider = (await this.document()).providers[providerID];
    if (!provider || provider.baseURL.includes("YOUR_")) throw new Error("请先配置此提供商。");
    return this.catalog(provider);
  }
  async select(role: "heavy" | "light", input: z.infer<typeof ModelSelection>): Promise<void> {
    const ref = ModelSelection.parse(input);
    await this.update(async settings => {
      const provider = settings.providers[ref.providerID]; if (!provider) throw new Error("未知提供商");
      const models = await this.catalog(provider);
      if (!models.some(model => model.id === ref.modelID)) throw new Error("该提供商没有返回所选模型。");
      settings.models[role] = ref;
    });
  }
  async jev(apiKey: string): Promise<void> {
    if (!apiKey.trim()) throw new Error("TypeSafe API key 不能为空。");
    await validateTypesafeKey(apiKey.trim(), this.signal);
    await this.update(async settings => { settings.jev = { type: "typesafe", apiKey: apiKey.trim(), repairAttempts: settings.jev.repairAttempts }; });
  }
}
