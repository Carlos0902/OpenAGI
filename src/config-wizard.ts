import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Settings } from "./settings.js";
import { availableModels, configuredModels, type AvailableModel, type ProviderType } from "./model-list.js";
import { TYPESAFE_BASE_URL, TYPESAFE_MODEL, TypesafeHTTPError, validateTypesafeKey } from "./typesafe.js";
import { withinProject } from "./boundary.js";
import { settingsDirectory, settingsFile } from "./config-location.js";
import type { ConversationIO } from "./terminal.js";
import { SessionStopped } from "./interactions.js";
import { NetworkRequestError } from "./network.js";

const choices: { type: ProviderType; label: string; url?: string }[] = [
  { type: "openai-compatible", label: "OpenAI-compatible / 自定义网关" },
  { type: "openai", label: "OpenAI Responses", url: "https://api.openai.com/v1" },
  { type: "anthropic", label: "Anthropic", url: "https://api.anthropic.com/v1" },
  { type: "google", label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
];
export interface WizardOptions { signal?: AbortSignal; fetch?: typeof fetch }

export async function configurationWizard(directory: string, io: ConversationIO, input?: string, options: WizardOptions = {}): Promise<string | undefined> {
  const file = await settingsFile(directory, input);
  const fetcher = options.fetch ?? fetch;
  const secrets: string[] = [];
  const output = (message: string) => io.write(secrets.reduce((text, key) => key ? text.split(key).join("[hidden]") : text, message));
  async function ask(prompt: string, secret = false, promptChoices?: import("./web-types.js").PromptChoice[]): Promise<string> {
    options.signal?.throwIfAborted();
    if (secret && !io.secret) throw new Error("配置向导需要支持隐藏输入的终端。");
    const answer = await (secret ? io.secret!(prompt) : io.ask(prompt, promptChoices));
    if (answer === null || ["/exit", "/quit", "/退出"].includes(answer.trim().toLowerCase())) throw new SessionStopped();
    const trimmed = answer.trim(); if (secret && trimmed) secrets.push(trimmed); return trimmed;
  }
  async function chooseModel(label: string, models: AvailableModel[]): Promise<AvailableModel> {
    io.write(`\n${label}：从 provider 返回的列表中选择模型。`);
    let page = 0;
    while (true) {
      models.slice(page * 25, (page + 1) * 25).forEach((model, index) => output(`  ${page * 25 + index + 1}. ${model.id}${model.name !== model.id ? ` — ${model.name}` : ""}${model.contextWindow ? `（输入上限 ${model.contextWindow}）` : ""}`));
      const answer = await ask(`${label} 模型号或完整 ID${models.length > 25 ? "；n 下一页 / p 上一页" : ""}（/退出 取消）> `, false, [
        ...models.slice(page * 25, (page + 1) * 25).map(model => ({ value: model.id, label: model.name || model.id, description: model.id })),
        ...((page + 1) * 25 < models.length ? [{ value: "n", label: "下一页" }] : []),
        ...(page > 0 ? [{ value: "p", label: "上一页" }] : []),
      ]);
      if (answer === "n" && (page + 1) * 25 < models.length) { page++; continue; }
      if (answer === "p" && page > 0) { page--; continue; }
      const model = /^[1-9]\d*$/.test(answer) ? models[Number(answer) - 1] : models.find(model => model.id === answer);
      if (model) return model;
      io.write("请选择上面列表中的模型，不能填写不存在的 ID。");
    }
  }
  async function readProvider() {
    choices.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label}`));
    let selected: (typeof choices)[number];
    while (true) {
      const number = await ask("选择 provider 协议 [默认 1] > ", false, choices.map((choice, index) => ({ value: String(index + 1), label: choice.label })));
      const choice = choices[Number(number || "1") - 1];
      if (choice) { selected = choice; break; }
      io.write("请输入 1–4。");
    }
    while (true) {
      const baseURL = await ask(`provider API 基础地址${selected.url ? ` [${selected.url}]` : "（通常以 /v1 结尾）"} > `) || selected.url || "";
      try { const u = new URL(baseURL); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(); }
      catch { io.write("请输入不含密钥、查询串或片段的 HTTP(S) 地址。"); continue; }
      const apiKey = await ask("输入该 provider 的 API key（隐藏）> ", true);
      if (!apiKey) { io.write("API key 不能为空。"); continue; }
      io.write("正在验证 provider 并读取账号的可用模型列表…");
      try {
        const models = await availableModels(selected.type, baseURL, apiKey, options.signal, fetcher);
        return { provider: { type: selected.type, baseURL, apiKey, contextWindow: 128_000, maxOutputTokens: 8_192 }, models };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        output(error instanceof Error ? error.message : "读取模型列表失败。");
        await ask("回车重新填写地址和密钥，或输入 /退出 取消 > ");
      }
    }
  }
  async function readJevKey() {
    io.write(`\nJev 来源固定：TypeSafe\n接口：${TYPESAFE_BASE_URL}/systemone\n模型：${TYPESAFE_MODEL}\n此项不能切换来源、接口或模型，只填写你自己的 TypeSafe API key。`);
    while (true) {
      const key = await ask("TypeSafe Jev API key（隐藏）> ", true);
      if (!key) { io.write("TypeSafe API key 不能为空。"); continue; }
      while (true) {
        try { await validateTypesafeKey(key, options.signal, fetcher); return key; }
        catch (error) {
          if (options.signal?.aborted) throw error;
          if (error instanceof TypesafeHTTPError && error.status === 401) { output(error.message); break; }
          if (!(error instanceof NetworkRequestError)) throw error;
          output(error.message);
          io.write("模型选择已保留。\n  0. 用当前密钥重试（默认）\n  1. 更换 TypeSafe 密钥\n  2. 取消配置，保留原文件");
          let choice: string;
          while (true) {
            choice = await ask("选择重试方式编号 [默认 0] > ", false, [
              { value: "0", label: "用当前密钥重试" }, { value: "1", label: "更换 TypeSafe 密钥" }, { value: "2", label: "取消配置，保留原文件" },
            ]) || "0";
            if (["0", "1", "2"].includes(choice)) break;
            io.write("请选择 0–2。");
          }
          if (choice === "2") throw new SessionStopped();
          if (choice === "1") break;
        }
      }
    }
  }
  function providerKey(provider: Settings["providers"][string]): string {
    const key = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    if (!key) throw new Error("已有 provider 未配置可用密钥，请先选择修改 provider API key。");
    secrets.push(key); return key;
  }
  async function chooseProvider(settings: Settings): Promise<string> {
    const ids = Object.keys(settings.providers);
    if (ids.length === 1) return ids[0]!;
    ids.forEach((id, index) => output(`  ${index + 1}. ${id} — ${settings.providers[id]!.baseURL}`));
    while (true) {
      const answer = await ask("选择要修改的 provider 编号或 ID > ", false, ids.map(id => ({ value: id, label: id, description: settings.providers[id]!.baseURL })));
      const id = /^[1-9]\d*$/.test(answer) ? ids[Number(answer) - 1] : ids.find(id => id === answer);
      if (id) return id;
      io.write("请选择已有 provider。");
    }
  }
  try {
    let existing: Settings | undefined; let fileExists = false;
    try {
      const content = await readFile(file, "utf8"); fileExists = true;
      const parsed = Settings.safeParse(JSON.parse(content)); if (parsed.success) existing = parsed.data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !fileExists) throw error; }
    if (existing) {
      for (const secret of [...Object.values(existing.providers), existing.jev, ...(existing.search ? [existing.search] : [])]) {
        if (secret.apiKey) secrets.push(secret.apiKey);
        if (secret.apiKeyEnv && process.env[secret.apiKeyEnv]) secrets.push(process.env[secret.apiKeyEnv]!);
      }
    }
    io.write("OpenAGI 配置向导\nAPI key 隐藏输入；输入 /退出 可取消，完成之前不会覆盖原配置。");
    let selection = "6";
    if (fileExists) {
      output(`已经有配置：${file}`);
      if (existing) {
        for (const [id, provider] of Object.entries(existing.providers)) output(`  Provider ${id}: ${provider.type} / ${provider.baseURL}（密钥隐藏）`);
        output(`  Heavy: ${existing.models.heavy.providerID}/${existing.models.heavy.modelID}\n  Light: ${existing.models.light.providerID}/${existing.models.light.modelID}\n  Jev: TypeSafe / ${TYPESAFE_MODEL}（密钥隐藏）`);
        io.write("选择要覆盖的配置：\n  0. 保留配置并退出（默认）\n  1. Provider 地址/协议/密钥（重选使用它的模型）\n  2. Heavy model\n  3. Light model\n  4. Heavy 和 Light model\n  5. TypeSafe Jev API key\n  6. 重新配置全部 provider、模型和 Jev\n  7. Provider API key");
      } else io.write("已有配置格式无效或版本过旧，无法局部修改。\n  0. 保留原文件并退出（默认）\n  6. 重新配置全部");
      while (true) {
        selection = await ask("选择要覆盖的配置 [默认 0] > ", false, (existing ? [
          "保留配置并退出", "Provider 地址、协议和密钥", "Heavy model", "Light model", "Heavy 和 Light model", "TypeSafe Jev API key", "重新配置全部", "Provider API key",
        ].map((label, index) => ({ value: String(index), label })) : [{ value: "0", label: "保留配置并退出" }, { value: "6", label: "重新配置全部" }])) || "0";
        if ((existing ? ["0", "1", "2", "3", "4", "5", "6", "7"] : ["0", "6"]).includes(selection)) break;
        io.write("请选择上面列出的编号。");
      }
      if (selection === "0") { io.write("已保留现有配置。"); return file; }
    }
    let settings: Settings;
    if (selection === "6") {
      const { provider, models } = await readProvider();
      io.write("Heavy 用于发现功能、规划、代码执行和独立验收；Light 用于日常对话，两者可以相同。");
      const heavy = await chooseModel("Heavy model", models); const light = await chooseModel("Light model", models);
      provider.contextWindow = Math.min(heavy.contextWindow ?? 128_000, light.contextWindow ?? 128_000);
      provider.maxOutputTokens = Math.min(heavy.maxOutputTokens ?? 8_192, light.maxOutputTokens ?? 8_192);
      settings = Settings.parse({ version: 2, providers: { primary: provider },
        models: { heavy: { providerID: "primary", modelID: heavy.id }, light: { providerID: "primary", modelID: light.id } },
        jev: { type: "typesafe", apiKey: await readJevKey(), repairAttempts: existing?.jev.repairAttempts ?? 1 }, search: existing?.search, clarification: existing?.clarification });
    } else {
      settings = structuredClone(existing!);
      if (selection === "5") settings.jev = { type: "typesafe", apiKey: await readJevKey(), repairAttempts: settings.jev.repairAttempts };
      else if (selection === "1" || selection === "7") {
        const id = await chooseProvider(settings);
        if (selection === "1") {
          const { provider, models } = await readProvider();
          settings.providers[id] = provider;
          for (const role of ["heavy", "light"] as const) if (settings.models[role].providerID === id) {
            const model = await chooseModel(`${role === "heavy" ? "Heavy" : "Light"} model`, models);
            settings.models[role] = { providerID: id, modelID: model.id };
          }
        } else {
          const provider = settings.providers[id]!;
          while (true) {
            const key = await ask(`Provider ${id} API key（隐藏）> `, true);
            if (!key) { io.write("API key 不能为空。"); continue; }
            const models = await configuredModels(provider, key, options.signal, fetcher);
            const missing = Object.values(settings.models).filter(ref => ref.providerID === id && !models.some(model => model.id === ref.modelID));
            if (missing.length) throw new Error("新密钥无法使用已有模型；请改选 Provider 地址/协议/密钥，同时重选模型。");
            settings.providers[id] = { ...provider, apiKey: key, apiKeyEnv: undefined }; break;
          }
        }
      } else {
        const catalogs = new Map<string, AvailableModel[]>();
        for (const role of ["heavy", "light"] as const) {
          if (selection !== "4" && selection !== (role === "heavy" ? "2" : "3")) continue;
          const id = settings.models[role].providerID; const provider = settings.providers[id]!;
          let models = catalogs.get(id);
          if (!models) { models = await configuredModels(provider, providerKey(provider), options.signal, fetcher); catalogs.set(id, models); }
          const model = await chooseModel(`${role === "heavy" ? "Heavy" : "Light"} model`, models);
          settings.models[role] = { providerID: id, modelID: model.id };
        }
      }
      settings = Settings.parse(settings);
    }
    await withinProject(settingsDirectory(directory, input), file); await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(settings, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      options.signal?.throwIfAborted(); await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    output(`\n配置已保存：${file}\nHeavy: ${settings.models.heavy.modelID}\nLight: ${settings.models.light.modelID}\nJev: TypeSafe / ${TYPESAFE_MODEL}（固定）\n密钥不会回显，文件权限为 0600。现在可以运行 openagi run。`);
    return file;
  } catch (error) {
    if (error instanceof SessionStopped || options.signal?.aborted) { io.write("配置已取消，原配置保持不变。"); return undefined; }
    io.write("配置未保存，原配置保持不变。处理上述问题后，请重新运行 openagi config。");
    throw error;
  }
}
