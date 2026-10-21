import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { backendConfiguration, prepareIsolation, projectGuardSource, validateIsolation } from "../src/isolation.js";
import { Settings } from "../src/settings.js";
import { runChecks } from "../src/workspace.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), "openagi-isolation-")); t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project"); await mkdir(root); await mkdir(join(root, ".openagi"));
  const config = join(root, ".openagi", "config.json"); await writeFile(config, "private configuration");
  const outside = join(parent, "outside.txt"); await writeFile(outside, "must-not-read");
  return { parent, root: await realpath(root), config: await realpath(config), outside: await realpath(outside) };
}

test("backend and checker sandboxes permit project files and reject sibling files and private configuration", { skip: process.platform !== "darwin" }, async t => {
  const { root, config, outside } = await fixture(t); const isolation = await prepareIsolation(root, config); await validateIsolation(isolation);
  await writeFile(join(root, "allowed.txt"), "project-data");
  const checks = await runChecks(root, [
    { name: "inside", command: process.execPath, args: ["-e", "console.log(require('node:fs').readFileSync('allowed.txt','utf8'))"], timeoutMs: 5000 },
    { name: "outside", command: process.execPath, args: ["-e", "console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))", outside], timeoutMs: 5000 },
    { name: "private", command: process.execPath, args: ["-e", "console.log(require('node:fs').readFileSync(process.argv[1],'utf8'))", config], timeoutMs: 5000 },
  ], undefined, isolation);
  assert.equal(checks[0]?.ok, true); assert.match(checks[0]!.stdout, /project-data/);
  assert.equal(checks[1]?.ok, false); assert(!checks[1]!.stdout.includes("must-not-read"));
  assert.equal(checks[2]?.ok, false); assert(!checks[2]!.stdout.includes("private configuration"));
  assert(isolation.environment.HOME!.startsWith(root)); assert.equal(isolation.environment.OPENCODE_CONFIG_PROJECT_DISABLE, "1"); assert.equal(isolation.environment.OPENAI_API_KEY, undefined);
});

test("backend configuration uses explicit provider endpoints/models/keys and disables inherited sources", { skip: process.platform !== "darwin" }, async t => {
  const { root, config } = await fixture(t); const isolation = await prepareIsolation(root, config);
  const settings = Settings.parse({ version: 2, providers: { custom: { type: "openai-compatible", baseURL: "https://own.example.test/v1", apiKey: "owned-key", headers: { "x-auth": "header-private" }, models: [{ id: "additional-manual", name: "Manual model", contextWindow: 64000, maxOutputTokens: 4096 }] } }, models: { heavy: { providerID: "custom", modelID: "owned-model" }, light: { providerID: "custom", modelID: "owned-light" } }, jev: { type: "typesafe", apiKey: "jev-test" } });
  const content = await backendConfiguration({ file: config, settings, keys: { custom: "owned-key" }, jevKey: "jev-test" }, isolation) as { model: string; providers: Record<string, { settings: { apiKey: string; baseURL: string }; headers: Record<string, string>; models: Record<string, unknown> }>; plugins: string[] };
  assert.equal(content.model, "openagi-config-custom/owned-model"); assert.deepEqual(Object.keys(content.providers), ["openagi-config-custom"]);
  assert.equal(content.providers["openagi-config-custom"]?.settings.apiKey, "owned-key"); assert.equal(content.providers["openagi-config-custom"]?.settings.baseURL, "https://own.example.test/v1");
  assert.deepEqual(content.providers["openagi-config-custom"]?.headers, { "x-auth": "header-private" });
  assert.deepEqual(content.providers["openagi-config-custom"]?.models["additional-manual"], { modelID: "additional-manual", name: "Manual model", capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 64000, output: 4096 } });
  assert(content.providers["openagi-config-custom"]?.models["owned-light"]); assert(content.plugins.includes("-opencode.config.instruction"));
  assert((await readFile(join(isolation.runtime, "project-guard", "index.js"), "utf8")).includes("openagi.project.guard"));
});

test("guard plugin blocks parent/symlink reads, external-directory approvals and unknown tools while reusing normal tools", async t => {
  const { root, config, outside } = await fixture(t);
  await symlink(outside, join(root, "link.txt")); const file = join(root, "guard.mjs"); await writeFile(file, projectGuardSource(root, config, ["custom"]));
  const plugin = (await import(pathToFileURL(file).href)).default;
  const hooks: Record<string, (value: any) => Promise<void>> = {}; const removed: string[] = [];
  await plugin.setup({ location: { directory: root },
    tool: { async transform(callback: any) { callback({ list: () => [{ name: "read", id: "read" }, { name: "arbitrary-mcp", id: "mcp" }], remove: (id: string) => removed.push(id) }); }, async hook(name: string, callback: any) { hooks[`tool:${name}`] = callback; } },
    permission: { async hook(name: string, callback: any) { hooks[`permission:${name}`] = callback; } },
    shell: { async hook(name: string, callback: any) { hooks[`shell:${name}`] = callback; } },
    provider: { async transform(callback: any) { callback({ list: () => [{ provider: { id: "custom" } }, { provider: { id: "opencode-go" } }], remove: (id: string) => removed.push(id) }); } },
    session: { async hook(name: string, callback: any) { hooks[`session:${name}`] = callback; } },
  });
  assert(removed.includes("mcp")); assert(removed.includes("opencode-go")); assert(!removed.includes("read"));
  await assert.rejects(hooks["tool:execute.before"]!({ tool: "read", input: { path: outside } }), /outside current project/);
  await assert.rejects(hooks["tool:execute.before"]!({ tool: "read", input: { path: "link.txt" } }), /symlink/);
  await assert.rejects(hooks["tool:execute.before"]!({ tool: "read", input: { path: ".openagi/config.json" } }), /private/);
  const request = { action: "external_directory", effect: "ask" }; await hooks["permission:evaluate"]!(request); assert.equal(request.effect, "deny");
  const invocation = { cwd: root, env: { OPENCODE_CONFIG_CONTENT: "secret", TAVILY_API_KEY: "secret", PATH: "/bin" } }; await hooks["shell:create.before"]!(invocation);
  assert.deepEqual(invocation.env, { PATH: "/bin" });
});
