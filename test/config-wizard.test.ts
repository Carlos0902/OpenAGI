import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configurationWizard } from "../src/config-wizard.js";
import { availableModels } from "../src/model-list.js";
import { Settings } from "../src/settings.js";
import { TYPESAFE_BASE_URL, TYPESAFE_MODEL } from "../src/typesafe.js";
import type { ConversationIO } from "../src/terminal.js";

class IO implements ConversationIO {
  readonly lines: string[] = []; readonly prompts: string[] = []; readonly secrets: string[] = [];
  constructor(private answers: (string | null)[], private keys: (string | null)[]) {}
  write(message: string) { this.lines.push(message); }
  async ask(prompt: string) { this.prompts.push(prompt); return this.answers.shift() ?? null; }
  async secret(prompt: string) { this.secrets.push(prompt); return this.keys.shift() ?? null; }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "openagi-wizard-")); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function existingFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fixture(t); await mkdir(join(root, ".openagi"));
  const settings = Settings.parse({ version: 2,
    providers: { primary: { type: "openai-compatible", baseURL: "https://llm.example.test/v1", apiKey: "existing-provider-secret" }, secondary: { type: "anthropic", baseURL: "https://other.example.test/v1", apiKeyEnv: "OTHER_KEY" } },
    models: { heavy: { providerID: "primary", modelID: "strong" }, light: { providerID: "primary", modelID: "fast" } },
    jev: { type: "typesafe", apiKey: "existing-jev-secret", repairAttempts: 2 }, search: { provider: "exa", apiKey: "existing-search-secret" },
  });
  const file = join(root, ".openagi", "config.json"); const original = JSON.stringify(settings, null, 2) + "\n";
  await writeFile(file, original); return { root, file, settings, original };
}

test("existing configuration defaults to keeping the file without network or credential prompts", async t => {
  const { root, file, original } = await existingFixture(t); const io = new IO([""], []);
  assert.equal(await configurationWizard(root, io, ".openagi/config.json", { fetch: async () => { throw new Error("No network expected"); } }), await realpath(file));
  assert.equal(await readFile(file, "utf8"), original); assert.equal(io.secrets.length, 0);
  assert(io.lines.some(line => line.includes("已经有配置"))); assert(!io.lines.join("\n").includes("-secret"));
});

test("Heavy, Light and combined updates preserve providers, Jev and search, reusing existing credentials", async t => {
  for (const selection of ["2", "3", "4"]) {
    const { root, file, settings } = await existingFixture(t);
    const io = new IO([selection, "new", "new"], []); let calls = 0;
    await configurationWizard(root, io, ".openagi/config.json", { fetch: async (input, options) => {
      calls++; assert.equal(String(input), "https://llm.example.test/v1/models");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer existing-provider-secret");
      return json({ data: [{ id: "new" }] });
    } });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.equal(saved.models.heavy.modelID, selection === "3" ? "strong" : "new");
    assert.equal(saved.models.light.modelID, selection === "2" ? "fast" : "new");
    assert.deepEqual(saved.providers, settings.providers); assert.deepEqual(saved.jev, settings.jev); assert.deepEqual(saved.search, settings.search);
    assert.equal(calls, 1); assert.equal(io.secrets.length, 0); assert(!io.lines.join("\n").includes("-secret"));
  }
});

test("Jev-only update validates only TypeSafe and preserves every other setting", async t => {
  const { root, file, settings } = await existingFixture(t); const io = new IO(["5"], ["new-jev-secret"]);
  await configurationWizard(root, io, ".openagi/config.json", { fetch: async (input, options) => {
    assert.equal(String(input), `${TYPESAFE_BASE_URL}/models`);
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer new-jev-secret");
    return json({ models: [{ name: TYPESAFE_MODEL }] });
  } });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, { ...settings, jev: { ...settings.jev, apiKey: "new-jev-secret" } });
  assert(!io.lines.join("\n").includes("-secret"));
});

test("provider-key-only update retains models, provider metadata and unrelated providers", async t => {
  const { root, file, settings } = await existingFixture(t); const io = new IO(["7", "primary"], ["new-provider-secret"]);
  await configurationWizard(root, io, ".openagi/config.json", { fetch: async (input, options) => {
    assert.equal(String(input), "https://llm.example.test/v1/models");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer new-provider-secret");
    return json({ data: [{ id: "strong" }, { id: "fast" }] });
  } });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, { ...settings, providers: { ...settings.providers, primary: { ...settings.providers.primary, apiKey: "new-provider-secret" } } });
});

test("provider replacement reselects dependent models and preserves unrelated configuration", async t => {
  const { root, file, settings } = await existingFixture(t);
  const io = new IO(["1", "primary", "1", "https://replacement.example.test/v1", "new", "new"], ["replacement-secret"]);
  await configurationWizard(root, io, ".openagi/config.json", { fetch: async input => {
    assert.equal(String(input), "https://replacement.example.test/v1/models"); return json({ data: [{ id: "new" }] });
  } });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.providers.primary.baseURL, "https://replacement.example.test/v1");
  assert.equal(saved.models.heavy.modelID, "new"); assert.equal(saved.models.light.modelID, "new");
  assert.deepEqual(saved.providers.secondary, settings.providers.secondary); assert.deepEqual(saved.jev, settings.jev); assert.deepEqual(saved.search, settings.search);
});

test("cancelled or failed partial updates leave existing configuration byte-for-byte unchanged", async t => {
  const { root, file, original } = await existingFixture(t);
  const cancelled = new IO(["5"], [null]);
  assert.equal(await configurationWizard(root, cancelled, ".openagi/config.json"), undefined);
  assert.equal(await readFile(file, "utf8"), original);
  await assert.rejects(configurationWizard(root, new IO(["5"], ["new-key"]), ".openagi/config.json", { fetch: async () => json({}, 451) }), /HTTP 451/);
  assert.equal(await readFile(file, "utf8"), original);
});

test("wizard validates providers, chooses only listed heavy/light models and locks TypeSafe Jev", async t => {
  const root = await fixture(t); const io = new IO(["1", "https://llm.example.test/v1", "not-in-list", "2", "1"], ["provider-private-key", "typesafe-private-key"]);
  const calls: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); const headers = new Headers(options?.headers); calls.push({ url, headers });
    return url === `${TYPESAFE_BASE_URL}/models` ? json({ models: [{ name: TYPESAFE_MODEL }] }) : json({ data: [{ id: "fast" }, { id: "strong" }] });
  };
  const file = await configurationWizard(root, io, ".openagi/config.json", { fetch: fetcher }); assert(file);
  const config = Settings.parse(JSON.parse(await readFile(file, "utf8")));
  assert.equal(config.models.heavy.modelID, "strong"); assert.equal(config.models.light.modelID, "fast");
  assert.equal(config.jev.type, "typesafe"); assert.equal(config.jev.apiKey, "typesafe-private-key");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(calls[0]?.headers.get("authorization"), "Bearer provider-private-key");
  assert.equal(calls[1]?.url, `${TYPESAFE_BASE_URL}/models`); assert.equal(calls[1]?.headers.get("authorization"), "Bearer typesafe-private-key");
  assert(io.lines.some(line => line.includes("不能填写不存在")));
  assert(!io.lines.join("\n").includes("private-key"));
  assert(!io.prompts.some(prompt => /选择.*Jev/.test(prompt)));
  assert.equal(Settings.safeParse({ ...config, jev: { ...config.jev, url: "https://another.test", model: "another" } }).success, false);
});

test("wrong provider/TypeSafe keys can be retried without saving invalid credentials", async t => {
  const root = await fixture(t); const io = new IO(["1", "https://llm.example.test/v1", "", "https://llm.example.test/v1", "1", "1"], ["bad-provider", "good-provider", "bad-jev", "good-jev"]);
  const fetcher: typeof fetch = async (input, options) => {
    const key = new Headers(options?.headers).get("authorization");
    if (key?.includes("bad")) return json({ error: "unauthorized" }, 401);
    return String(input).startsWith(TYPESAFE_BASE_URL) ? json({ models: [{ name: TYPESAFE_MODEL }] }) : json({ data: [{ id: "only-model" }] });
  };
  const file = await configurationWizard(root, io, ".openagi/config.json", { fetch: fetcher }); assert(file);
  const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.providers.primary.apiKey, "good-provider"); assert.equal(config.jev.apiKey, "good-jev");
  assert(io.lines.some(line => line.includes("401"))); assert(!io.lines.join("\n").includes("bad-provider"));
});

test("TypeSafe network failure retries the same hidden key while retaining provider and model choices", async t => {
  const root = await fixture(t); const io = new IO(["1", "https://llm.example.test/v1", "2", "1", "0"], ["provider-private-key", "jev-private-key"]);
  let jevCalls = 0; let providerCalls = 0;
  const file = await configurationWizard(root, io, ".openagi/config.json", { fetch: async (input, options) => {
    if (String(input).startsWith(TYPESAFE_BASE_URL)) {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer jev-private-key");
      if (++jevCalls === 1) throw new TypeError("fetch failed jev-private-key", { cause: Object.assign(new Error("proxy unavailable"), { code: "ECONNREFUSED" }) });
      return json({ models: [{ name: TYPESAFE_MODEL }] });
    }
    providerCalls++; return json({ data: [{ id: "fast" }, { id: "strong" }] });
  } });
  assert(file); const config = JSON.parse(await readFile(file, "utf8"));
  assert.equal(config.models.heavy.modelID, "strong"); assert.equal(config.models.light.modelID, "fast");
  assert.equal(providerCalls, 1); assert.equal(jevCalls, 2); assert.equal(io.secrets.length, 2);
  assert(io.lines.some(line => line.includes("ECONNREFUSED"))); assert(!io.lines.join("\n").includes("private-key"));
});

test("cancelling a network retry keeps an existing configuration unchanged", async t => {
  const { root, file, original } = await existingFixture(t);
  const io = new IO(["5", "2"], ["new-jev-key"]);
  assert.equal(await configurationWizard(root, io, ".openagi/config.json", { fetch: async () => { throw new DOMException("timeout", "TimeoutError"); } }), undefined);
  assert.equal(await readFile(file, "utf8"), original);
});

test("TypeSafe access/service failures stop instead of repeatedly asking for keys, preserving prior configuration", async t => {
  const root = await fixture(t); await mkdir(join(root, ".openagi"));
  const file = join(root, ".openagi", "config.json"); const original = '{"previous":"unchanged"}\n'; await writeFile(file, original);
  for (const status of [451, 403, 429, 503]) {
    const io = new IO(["6", "1", "https://llm.example.test/v1", "1", "1"], ["provider-key", "jev-key", "must-not-request-again"]);
    let jevCalls = 0;
    await assert.rejects(configurationWizard(root, io, ".openagi/config.json", { fetch: async input => {
      if (String(input).startsWith(TYPESAFE_BASE_URL)) { jevCalls++; return json({ title: "Access unavailable" }, status); }
      return json({ data: [{ id: "only-model" }] });
    } }), new RegExp(`HTTP ${status}`));
    assert.equal(jevCalls, 1); assert.equal(io.secrets.length, 2);
    assert.equal(await readFile(file, "utf8"), original);
    assert(io.lines.some(line => line.includes("配置未保存")));
  }
});

test("cancellation leaves a previous configuration byte-for-byte unchanged", async t => {
  const root = await fixture(t); await mkdir(join(root, ".openagi")); const file = join(root, ".openagi", "config.json");
  const original = '{"previous":"must remain unchanged"}\n'; await writeFile(file, original);
  const io = new IO(["6", "1", "https://llm.example.test/v1", "/退出"], ["key"]);
  assert.equal(await configurationWizard(root, io, ".openagi/config.json", { fetch: async () => json({ data: [{ id: "model" }] }) }), undefined);
  assert.equal(await readFile(file, "utf8"), original);
});

test("provider model lists use protocol-specific auth and pagination, filtering Gemini non-generation models", async () => {
  const requests: { url: URL; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); requests.push({ url, headers: new Headers(options?.headers) });
    if (url.hostname === "anthropic.test") return url.searchParams.has("after_id") ? json({ data: [{ id: "second" }], has_more: false }) : json({ data: [{ id: "first" }], has_more: true, last_id: "first" });
    return url.searchParams.has("pageToken") ? json({ models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent"] }] }) : json({ models: [{ name: "models/embedding", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-a", displayName: "Gemini A", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" });
  };
  assert.deepEqual((await availableModels("anthropic", "https://anthropic.test/v1", "key", undefined, fetcher)).map(model => model.id), ["first", "second"]);
  assert.equal(requests[0]?.headers.get("x-api-key"), "key"); assert.equal(requests[1]?.url.searchParams.get("after_id"), "first");
  assert.deepEqual((await availableModels("google", "https://google.test/v1beta", "key", undefined, fetcher)).map(model => model.id), ["gemini-a", "gemini-b"]);
  assert.equal(requests[2]?.headers.get("x-goog-api-key"), "key"); assert.equal(requests[3]?.url.searchParams.get("pageToken"), "next");
});

test("empty/malformed model catalogs never silently become hardcoded model choices", async () => {
  await assert.rejects(availableModels("openai-compatible", "https://provider.test/v1", "key", undefined, async () => json({ data: [] })), /没有返回可用/);
  await assert.rejects(availableModels("openai-compatible", "https://provider.test/v1", "key", undefined, async () => json({ not_models: [] })), /无法识别/);
});
