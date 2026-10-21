import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigurationEditor } from "../src/config-editor.js";
import { settingsTemplate } from "../src/settings.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, initialize = true) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-config-editor-")); const previous = process.env.OPENAGI_ROOT; process.env.OPENAGI_ROOT = directory;
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== "Bearer provider-secret") { response.writeHead(401).end(); return; }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "heavy" }, { id: "light" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); assert(address && typeof address !== "string"); const baseURL = `http://127.0.0.1:${address.port}/v1`;
  t.after(async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await rm(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.OPENAGI_ROOT; else process.env.OPENAGI_ROOT = previous; });
  const file = join(directory, ".openagi", "config.json");
  if (initialize) { await mkdir(join(directory, ".openagi")); await writeFile(file, JSON.stringify({ ...settingsTemplate, providers: { primary: { type: "openai-compatible", baseURL, apiKey: "provider-secret", contextWindow: 128000, maxOutputTokens: 8192 } }, models: { heavy: { providerID: "primary", modelID: "heavy" }, light: { providerID: "primary", modelID: "light" } }, jev: { type: "typesafe", apiKey: "unverified-jev-secret", repairAttempts: 1 } })); }
  const editor = new ConfigurationEditor(); const edit = { id: "primary", type: "openai-compatible" as const, baseURL, contextWindow: 128000, maxOutputTokens: 8192 };
  return { directory, file, editor, edit };
}

test("native configuration exposes public fields only, independently edits a provider and retains hidden keys", async t => {
  const f = await fixture(t);
  assert(!JSON.stringify(await f.editor.view()).includes("provider-secret")); assert(!JSON.stringify(await f.editor.view()).includes("unverified-jev-secret"));
  await f.editor.provider({ ...f.edit, contextWindow: 64000, apiKey: "" });
  const saved = JSON.parse(await readFile(f.file, "utf8")); assert.equal(saved.providers.primary.apiKey, "provider-secret"); assert.equal(saved.providers.primary.contextWindow, 64000); assert.equal(saved.jev.apiKey, "unverified-jev-secret", "Provider edits do not require Jev authentication");
  if (process.platform !== "win32") assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});
test("provider and model validation failures preserve the complete existing configuration", async t => {
  const f = await fixture(t); const original = await readFile(f.file, "utf8");
  await assert.rejects(f.editor.provider({ ...f.edit, apiKey: "wrong-key" }), /HTTP 401/);
  await assert.rejects(f.editor.select("heavy", { providerID: "primary", modelID: "invented-model" }), /没有返回/);
  await assert.rejects(f.editor.remove("primary"), /仍被/);
  assert.equal(await readFile(f.file, "utf8"), original);
});
test("new provider and Heavy/Light selections update the global source and serialize simultaneous edits", async t => {
  const f = await fixture(t);
  await f.editor.provider({ ...f.edit, id: "secondary", apiKey: "provider-secret" });
  await Promise.all([f.editor.select("heavy", { providerID: "secondary", modelID: "heavy" }), f.editor.select("light", { providerID: "secondary", modelID: "light" })]);
  await f.editor.remove("primary");
  const view = await f.editor.view(); assert.deepEqual(view.models, { heavy: { providerID: "secondary", modelID: "heavy" }, light: { providerID: "secondary", modelID: "light" } }); assert.deepEqual(view.providers.map(provider => provider.id), ["secondary"]);
});
test("first native provider save removes unused template providers and allows incremental configuration", async t => {
  const f = await fixture(t, false);
  assert.deepEqual((await f.editor.view()).providers, []);
  await f.editor.provider({ ...f.edit, id: "gateway", apiKey: "provider-secret" });
  const document = JSON.parse(await readFile(f.file, "utf8")); assert.deepEqual(Object.keys(document.providers), ["gateway"]); assert.equal(document.models.heavy.providerID, "gateway"); assert.equal(document.models.light.providerID, "gateway"); assert.equal((await f.editor.view()).jevConfigured, false);
});

test("custom providers without a models endpoint save declared IDs and private header authentication", async t => {
  const f = await fixture(t);
  const manual = { ...f.edit, id: "custom", name: "Custom gateway", baseURL: "http://127.0.0.1:1/v1", apiKey: "", models: [{ id: "gpt-6.1-sol", name: "Heavy" }, { id: "gpt-6-luna", name: "Light" }], headers: [{ key: "Authorization", value: "Bearer header-secret" }] };
  await f.editor.provider(manual);
  await f.editor.select("heavy", { providerID: "custom", modelID: "gpt-6.1-sol" });
  await f.editor.select("light", { providerID: "custom", modelID: "gpt-6-luna" });
  assert.deepEqual((await f.editor.models("custom")).map(model => model.id), ["gpt-6.1-sol", "gpt-6-luna"]);
  const view = await f.editor.view(); assert(!JSON.stringify(view).includes("header-secret")); assert.deepEqual(view.providers.find(provider => provider.id === "custom")?.headerNames, ["Authorization"]);
  await f.editor.provider({ ...manual, headers: [{ key: "Authorization", value: "" }] });
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).providers.custom.headers.Authorization, "Bearer header-secret");
  await assert.rejects(f.editor.select("heavy", { providerID: "custom", modelID: "invented" }), /没有返回/);
});
test("header edits reject unsafe and duplicate names without overwriting configuration", async t => {
  const f = await fixture(t); const before = await readFile(f.file, "utf8");
  for (const headers of [[{ key: "Invalid Name", value: "secret" }], [{ key: "x-auth", value: "secret\r\nInjected: true" }], [{ key: "X-Auth", value: "one" }, { key: "x-auth", value: "two" }]]) {
    await assert.rejects(f.editor.provider({ ...f.edit, models: [{ id: "heavy" }, { id: "light" }], headers }));
  }
  assert.equal(await readFile(f.file, "utf8"), before);
});
