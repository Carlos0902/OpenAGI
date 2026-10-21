import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Model, type ProjectConfig } from "./domain.js";
import { settingsFile } from "./config-location.js";
import { ClarificationPolicy, defaultClarificationPolicy } from "./clarification.js";

const Endpoint = z.url().refine(value => { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; }, "地址须为 HTTP(S)，密钥不能写在 URL 中");
const Secret = z.object({ apiKey: z.string().min(1).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }).refine(value => !(value.apiKey && value.apiKeyEnv), "apiKey 与 apiKeyEnv 只能填写一个");
export const ProviderModel = z.object({ id: z.string().trim().min(1).refine(value => !/\s/.test(value), "模型 ID 不能包含空格"), name: z.string().trim().min(1).optional(), contextWindow: z.number().int().min(1000).optional(), maxOutputTokens: z.number().int().positive().optional() });
const Headers = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().min(1).refine(value => !/[\r\n]/.test(value), "请求头不能包含换行"));
const Provider = z.object({
  type: z.enum(["openai-compatible", "openai", "anthropic", "google"]), baseURL: Endpoint,
  name: z.string().trim().min(1).optional(),
  models: z.array(ProviderModel).refine(models => new Set(models.map(model => model.id)).size === models.length, "模型 ID 不能重复").optional(), headers: Headers.optional(),
  apiKey: z.string().min(1).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  contextWindow: z.number().int().min(1_000).default(128_000), maxOutputTokens: z.number().int().positive().default(8_192),
}).refine(value => !(value.apiKey && value.apiKeyEnv), "apiKey 与 apiKeyEnv 只能填写一个");
const RepairCount = z.number().int().min(0).max(3).default(1);
export const Settings = z.object({
  version: z.literal(2),
  providers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), Provider),
  models: z.object({ heavy: Model, light: Model }).strict(),
  jev: z.object({ type: z.literal("typesafe"), apiKey: z.string().min(1).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), repairAttempts: RepairCount }).strict(),
  search: z.object({ provider: z.enum(["tavily", "exa", "firecrawl", "parallel", "tinyfish"]), apiKey: z.string().min(1).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }).optional(),
  clarification: ClarificationPolicy.optional(),
}).superRefine((settings, context) => {
  for (const ref of [settings.models.heavy, settings.models.light]) if (!settings.providers[ref.providerID]) context.addIssue({ code: "custom", path: ["providers", ref.providerID], message: "模型引用的提供方没有在 OpenAGI 配置中声明" });
  if (!!settings.jev.apiKey === !!settings.jev.apiKeyEnv) context.addIssue({ code: "custom", path: ["jev"], message: "请提供自己的 TypeSafe API key；apiKey 与 apiKeyEnv 须二选一" });
});
export type Settings = z.infer<typeof Settings>;
export interface LoadedSettings { file: string; settings: Settings; keys: Record<string, string | undefined>; jevKey: string; searchKey?: string }
export const backendProviderId = (id: string): string => `openagi-config-${id}`;

export const settingsTemplate = {
  version: 2,
  providers: { primary: { type: "openai-compatible", baseURL: "https://YOUR_API_HOST/v1", apiKey: "YOUR_API_KEY", contextWindow: 128000, maxOutputTokens: 8192 } },
  models: { heavy: { providerID: "primary", modelID: "YOUR_HEAVY_MODEL_ID" }, light: { providerID: "primary", modelID: "YOUR_LIGHT_MODEL_ID" } },
  jev: { type: "typesafe", apiKey: "YOUR_TYPESAFE_API_KEY", repairAttempts: 1 },
};

export class SettingsRequired extends Error {}
export async function createSettingsTemplate(directory: string, input?: string): Promise<string> {
  const file = await settingsFile(directory, input);
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(settingsTemplate, null, 2) + "\n"); }
  finally { await handle.close(); }
  return file;
}

export async function loadSettings(directory: string, input?: string, environment: NodeJS.ProcessEnv = process.env): Promise<LoadedSettings> {
  const file = await settingsFile(directory, input);
  let content: string;
  try { content = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try { await createSettingsTemplate(directory, input); }
    catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError; }
    throw new SettingsRequired(`已创建 OpenAGI 配置模板：${file}\n请运行 openagi config 填写提供方、模型和 API key后重新运行 openagi run。不会使用 OpenCode 的模型设置。`);
  }
  let settings: Settings;
  try {
    const decoded = JSON.parse(content);
    if (decoded.version === 1) throw new SettingsRequired(`当前配置为旧版本，Jev 来源现已固定 TypeSafe。请运行 openagi config 选择 Heavy/Light 模型并输入自己的 TypeSafe API key。`);
    settings = Settings.parse(decoded);
  }
  catch (error) {
    if (error instanceof SettingsRequired) throw error;
    const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n") : "文件不是合法 JSON";
    throw new SettingsRequired(`OpenAGI 配置无效：${file}\n${message}`);
  }
  if (JSON.stringify(settings).includes("YOUR_")) throw new SettingsRequired(`请先替换 OpenAGI 配置模板中的 YOUR_ 占位值：${file}`);
  const resolveKey = (secret: { apiKey?: string; apiKeyEnv?: string }, label: string) => {
    Secret.parse(secret);
    if (secret.apiKeyEnv && !environment[secret.apiKeyEnv]) throw new SettingsRequired(`${label} 缺少环境变量 ${secret.apiKeyEnv}。也可在 OpenAGI 全局配置中填写 apiKey。`);
    return secret.apiKey ?? (secret.apiKeyEnv ? environment[secret.apiKeyEnv] : undefined);
  };
  const keys = Object.fromEntries(Object.entries(settings.providers).map(([id, provider]) => [id, resolveKey(provider, `提供方 ${id}`)]));
  const jevKey = resolveKey(settings.jev, "TypeSafe Jev")!;
  const searchKey = settings.search ? resolveKey(settings.search, "搜索服务") : undefined;
  return { file: await realpath(file), settings, keys, jevKey, searchKey };
}

/** Only public selections enter state.json; provider secrets stay in the user configuration/in memory. */
export function applySettings(project: ProjectConfig, loaded: LoadedSettings): void {
  const { settings } = loaded;
  for (const role of ["discovery", "guider", "worker", "validator", "collector"] as const) project.models[role] = settings.models.heavy;
  project.models.dialogue = settings.models.light;
  project.jev = { type: "typesafe", repairAttempts: settings.jev.repairAttempts };
  project.clarification = settings.clarification ?? defaultClarificationPolicy;
}

export function settingsSummary(loaded: LoadedSettings): string {
  const { settings } = loaded;
  return `模型配置：${loaded.file}\n  Heavy: ${settings.models.heavy.providerID}/${settings.models.heavy.modelID}\n  Light: ${settings.models.light.providerID}/${settings.models.light.modelID}\n  Jev: TypeSafe / jev-latest（来源与模型固定）`;
}


/** All credential values remain private even when a provider authenticates through custom headers. */
export function settingsSecrets(loaded: LoadedSettings): string[] {
  return [...Object.values(loaded.keys), loaded.jevKey, loaded.searchKey, ...Object.values(loaded.settings.providers).flatMap(provider => Object.values(provider.headers ?? {}))].filter((value): value is string => !!value);
}
