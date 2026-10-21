import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySettings, createSettingsTemplate, loadSettings, Settings, SettingsRequired } from "../src/settings.js";
import { ProjectConfig } from "../src/domain.js";
import { ConfiguredRuntime } from "../src/configured-runtime.js";
import { withinProject } from "../src/boundary.js";
import type { AgentRequest, AgentRuntime } from "../src/runtime.js";

const config = () => ({ version: 2, providers: { chosen: { type: "openai-compatible", baseURL: "https://models.example.test/v1", apiKey: "fixture-secret" } }, models: { heavy: { providerID: "chosen", modelID: "my-model" }, light: { providerID: "chosen", modelID: "my-light" } }, jev: { type: "typesafe", apiKey: "jev-fixture-key", repairAttempts: 1 } });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "openagi-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".openagi"));
  return root;
}

test("missing model configuration creates a private local template and refuses upstream defaults", async t => {
  const root = await fixture(t);
  await assert.rejects(loadSettings(root, ".openagi/config.json"), SettingsRequired);
  const file = join(root, ".openagi", "config.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const template = JSON.parse(await readFile(file, "utf8"));
  assert.equal(template.jev.type, "typesafe"); assert.equal(template.models.heavy.modelID, "YOUR_HEAVY_MODEL_ID");
  await assert.rejects(loadSettings(root, ".openagi/config.json", { OPENAI_API_KEY: "unrelated-key" }), /YOUR_/);
  await assert.rejects(createSettingsTemplate(root, ".openagi/config.json"), /EEXIST/);
});

test("models, provider endpoints and Jev all resolve from the project file without copying credentials to state", async t => {
  const root = await fixture(t); await writeFile(join(root, ".openagi", "config.json"), JSON.stringify(config()));
  const loaded = await loadSettings(root, ".openagi/config.json");
  const project = ProjectConfig.parse({ name: "scope", directory: root, modules: ["function-finder"], context: { goal: "Goal" }, opencode: {}, models: { worker: { providerID: "opencode-go", modelID: "old" } }, validation: { checks: [] } });
  applySettings(project, loaded);
  assert.equal(project.models.discovery?.modelID, "my-model"); assert.equal(project.models.worker?.modelID, "my-model"); assert.equal(project.models.dialogue?.modelID, "my-light");
  assert.equal(project.jev?.type, "typesafe"); assert(!JSON.stringify(project).includes("fixture-secret"));
  assert.equal(loaded.keys.chosen, "fixture-secret");
});

test("undefined Jev, unknown providers, conflicting keys and invalid environment names are configuration errors", async () => {
  const missing = config() as Record<string, unknown>; delete missing.jev;
  assert.equal(Settings.safeParse(missing).success, false);
  const unknown = config(); unknown.models.heavy.providerID = "unconfigured";
  assert.equal(Settings.safeParse(unknown).success, false);
  const conflicting = config(); Object.assign(conflicting.providers.chosen, { apiKeyEnv: "OPENAGI_KEY" });
  assert.equal(Settings.safeParse(conflicting).success, false);
});

test("only explicitly named API key environment variables are accepted", async t => {
  const root = await fixture(t); const input = config();
  const provider = input.providers.chosen as { apiKey?: string; apiKeyEnv?: string }; delete provider.apiKey; provider.apiKeyEnv = "OPENAGI_MY_KEY";
  await writeFile(join(root, ".openagi", "config.json"), JSON.stringify(input));
  await assert.rejects(loadSettings(root, ".openagi/config.json", { OPENAI_API_KEY: "wrong-source" }), /OPENAGI_MY_KEY/);
  assert.equal((await loadSettings(root, ".openagi/config.json", { OPENAGI_MY_KEY: "explicit-source" })).keys.chosen, "explicit-source");
});

test("configuration and task paths cannot escape through parent paths or symlinks", async t => {
  const root = await fixture(t); const sibling = await fixture(t);
  await writeFile(join(sibling, "config.json"), JSON.stringify(config()));
  await symlink(join(sibling, "config.json"), join(root, ".openagi", "config.json"));
  await assert.rejects(loadSettings(root, ".openagi/config.json"), /项目外/);
  await assert.rejects(withinProject(root, sibling), /项目/);
  await symlink(sibling, join(root, "external"));
  await assert.rejects(withinProject(root, "external/new-file.ts"), /项目外/);
});

test("configured runtime refuses implicit defaults and undeclared providers", async t => {
  const root = await fixture(t); await writeFile(join(root, ".openagi", "config.json"), JSON.stringify(config()));
  const requests: AgentRequest[] = [];
  const delegate: AgentRuntime = { async run(request) { requests.push(request); return { sessionId: "ses_owned", text: "ok" }; }, async search() { return []; } };
  const runtime = new ConfiguredRuntime(delegate, await loadSettings(root, ".openagi/config.json"), root);
  await assert.rejects(runtime.run({ directory: root, mode: "build", prompt: "implement" }), /不会使用 OpenCode 默认/);
  await assert.rejects(runtime.run({ directory: root, mode: "build", prompt: "implement", model: { providerID: "opencode-go", modelID: "old" } }), /未在当前 OpenAGI/);
  await runtime.run({ directory: root, mode: "build", prompt: "implement", model: { providerID: "chosen", modelID: "my-worker" } });
  assert.equal(requests.length, 1); assert.equal(requests[0]?.model?.modelID, "my-worker"); assert.equal(requests[0]?.model?.providerID, "openagi-config-chosen");
});

test("Jev source cannot be replaced by another model, service URL or provider", () => {
  const input = config();
  assert.equal(Settings.safeParse({ ...input, jev: { type: "http", url: "https://other.example.test" } }).success, false);
  assert.equal(Settings.safeParse({ ...input, jev: { ...input.jev, url: "https://other.example.test", model: "other" } }).success, false);
});

test("clarification thresholds are configurable, bounded and cannot become less strict on follow-up", () => {
  const input = config();
  const parsed = Settings.parse({ ...input, clarification: { decisionThreshold: 0.85, followupDecisionThreshold: 0.97 } });
  assert.equal(parsed.clarification?.decisionThreshold, 0.85);
  assert.equal(Settings.safeParse({ ...input, clarification: { decisionThreshold: 0.9, followupDecisionThreshold: 0.8 } }).success, false);
  assert.equal(Settings.safeParse({ ...input, clarification: { decisionThreshold: 1.1 } }).success, false);
});
