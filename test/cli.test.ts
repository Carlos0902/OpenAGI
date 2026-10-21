import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ProjectStore } from "../src/store.js";
import { Task } from "../src/domain.js";

const execute = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const loader = import.meta.resolve("tsx");
async function run(directory: string, ...args: string[]) {
  return execute(process.execPath, ["--import", loader, cli, ...args, "--path", directory], { cwd: directory, env: { ...process.env, OPENAGI_ROOT: directory }, timeout: 15_000 });
}
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("CLI init requires explicit modules/goal, detects project checks and returns machine-readable state", async t => {
  const directory = await temporary(t);
  await writeFile(join(directory, "package.json"), JSON.stringify({ packageManager: "pnpm@10.0.0", scripts: { typecheck: "tsc --noEmit", test: "node --test" } }));
  await assert.rejects(run(directory, "init"), /requires --modules and --goal/);
  const result = await run(directory, "init", "--modules", "function-finder,performance-optimizer", "--goal", "Improve onboarding", "--model", "test/model", "--json");
  const state = JSON.parse(result.stdout);
  assert.deepEqual(state.project.modules, ["function-finder", "performance-optimizer"]);
  assert.equal(state.project.models.worker.modelID, "model");
  assert.equal(state.project.validation.checks[0].command, "pnpm");
  assert.equal(state.project.validation.checks.length, 2);
  await assert.rejects(run(directory, "init", "--modules", "function-finder", "--goal", "Overwrite"), /already initialized/);
  assert.equal((await new ProjectStore(directory).read()).project.context.goal, "Improve onboarding");
});

test("CLI configuration replaces project settings and preserves historical tasks", async t => {
  const directory = await temporary(t);
  await run(directory, "init", "--modules", "function-finder", "--goal", "Original goal");
  const store = new ProjectStore(directory);
  await store.withLock(async () => {
    const state = await store.read();
    state.tasks.push(Task.parse({ id: "existing-task", title: "Existing feature", description: "Keep this historical decision", evidence: [{ location: "README.md", observation: "Current workflow" }], acceptanceCriteria: ["Feature works"], questions: [], modules: ["function-finder"], status: "ready", createdAt: "2026-10-09", updatedAt: "2026-10-09", priority: 80, runs: [], assessment: { necessity: 4, value: 4, urgency: 4, feasibility: 4, requirementClarity: 4, userDecisionRequired: false, rationale: "User value", reevaluateWhen: [] } }));
    await store.write(state);
  });
  const config = (await store.read()).project;
  config.context.goal = "Updated goal";
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  await run(directory, "configure", "--config", join(directory, "config.json"));
  assert.equal((await store.read()).tasks[0]?.id, "existing-task");
  assert.equal((await store.read()).project.context.goal, "Updated goal");
  const list = JSON.parse((await run(directory, "list", "--json")).stdout);
  assert.equal(list[0].id, "existing-task");
  assert.match((await run(directory, "show", "existing")).stdout, /Acceptance: Feature works/);
});

test("CLI rejects credentials in persisted server configuration and makes a check waiver explicit", async t => {
  const directory = await temporary(t);
  await assert.rejects(run(directory, "init", "--modules", "function-finder", "--goal", "Goal", "--opencode-url", "http://user:password@localhost:4096"), /credentials belong in environment variables/);
  await run(directory, "init", "--modules", "function-finder", "--goal", "Goal", "--no-checks");
  const state = JSON.parse(await readFile(join(directory, ".openagi", "state.json"), "utf8"));
  assert.equal(state.project.validation.requireChecks, false);
  assert.equal(state.project.validation.checks.length, 0);
});


test("run generates its own missing configuration without importing OpenCode defaults or changing project history", async t => {
  const directory = await temporary(t);
  await run(directory, "init", "--modules", "function-finder", "--goal", "已有摘要");
  await assert.rejects(run(directory, "run", "--cli"), /已创建 OpenAGI 配置模板/);
  const config = JSON.parse(await readFile(join(directory, ".openagi", "config.json"), "utf8"));
  assert.equal(config.jev.type, "typesafe");
  assert.equal(config.providers.primary.apiKey, "YOUR_API_KEY");
  assert.equal((await new ProjectStore(directory).read()).project.context.goal, "已有摘要");
  assert.deepEqual((await new ProjectStore(directory).read()).tasks, []);
});

test("the explicit CLI entry asks for model/Jev configuration before initializing product state", async t => {
  const directory = await temporary(t);
  const child = spawn(process.execPath, ["--import", loader, cli, "--cli"], { cwd: directory, env: { ...process.env, OPENAGI_ROOT: directory }, stdio: "pipe" });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 1); assert.match(stderr, /配置模板/);
  assert.equal(await new ProjectStore(directory).exists(), false);
});

test("a linked CLI executable invokes main when argv points to the npm-style symlink", async t => {
  const directory = await temporary(t);
  const linked = join(directory, "linked-openagi.ts"); await symlink(cli, linked);
  const result = await execute(process.execPath, ["--import", loader, linked, "--help"], { cwd: directory, env: { ...process.env, OPENAGI_ROOT: directory }, timeout: 15_000 });
  assert.match(result.stdout, /run \[SUMMARY\]/); assert.match(result.stdout, /持续交互/);
});

test("configuration bootstrap refuses to overwrite an existing file or select a sibling project", async t => {
  const directory = await temporary(t);
  await run(directory, "config", "init");
  await assert.rejects(run(directory, "config", "init"), /EEXIST/);
  await assert.rejects(execute(process.execPath, ["--import", loader, cli, "list", "--path", join(directory, "..")], { cwd: directory }), /超出当前项目/);
});

test("run starts a private configured backend, ignores upstream credentials and retains public model selections only", { skip: process.platform !== "darwin" }, async t => {
  const directory = await temporary(t);
  await run(directory, "init", "--modules", "function-finder", "--goal", "保留摘要");
  const store = new ProjectStore(directory);
  await store.withLock(async () => {
    const state = await store.read(); const now = new Date().toISOString();
    state.tasks = [Task.parse({ id: "saved-task", title: "待处理建议", description: "退出前不执行", evidence: [{ location: "README.md", observation: "Existing workflow" }], acceptanceCriteria: ["Feature works"], questions: [], modules: ["function-finder"], status: "ready", createdAt: now, updatedAt: now, priority: 80, runs: [], assessment: { necessity: 4, value: 4, urgency: 4, feasibility: 4, requirementClarity: 4, userDecisionRequired: false, rationale: "User value", reevaluateWhen: [] } })];
    await store.write(state);
  });
  await writeFile(join(directory, ".openagi", "config.json"), JSON.stringify({ version: 2, providers: { own: { type: "openai-compatible", baseURL: "http://127.0.0.1:9/v1", apiKey: "own-fixture-key" } }, models: { heavy: { providerID: "own", modelID: "my-model" }, light: { providerID: "own", modelID: "my-light" } }, jev: { type: "typesafe", apiKey: "jev-test" } }));
  const bin = join(directory, "test-bin"); await mkdir(bin);
  const marker = join(directory, "startup.json");
  const stub = `#!/usr/bin/env node
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),paths=[],config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const metadata={args,model:config.model,providers:Object.keys(config.providers),ownKey:config.providers['openagi-config-own'].settings.apiKey==='own-fixture-key',inheritedKey:!!process.env.OPENAI_API_KEY,home:process.env.HOME,projectDisable:process.env.OPENCODE_CONFIG_PROJECT_DISABLE};
const server=http.createServer((req,res)=>{paths.push(new URL(req.url,'http://fixture').pathname);fs.writeFileSync(path.join(process.cwd(),'startup.json'),JSON.stringify({...metadata,paths,port:server.address().port}));res.setHeader('content-type','application/json');if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')){res.writeHead(401);res.end('{}');return;}res.end(JSON.stringify(req.url.startsWith('/api/plugin')?{data:[{id:'openagi.project.guard',state:{status:'active'}}]}:{version:'2.0.26'}));});
server.listen(Number(args[args.indexOf('--port')+1]),args[args.indexOf('--hostname')+1]);
`;
  await writeFile(join(bin, "npm"), stub, { mode: 0o755 });
  const environment = { ...process.env, OPENAGI_ROOT: directory, PATH: `${bin}${delimiter}${process.env.PATH}`, OPENAI_API_KEY: "must-not-inherit" };
  const child = spawn(process.execPath, ["--import", loader, cli, "run", "--cli"], { cwd: directory, env: environment, stdio: "pipe" });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; }); child.stdin.end("1\n退出\n");
  const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, stderr); assert.match(stdout, /Jev: TypeSafe \/ jev-latest/); assert.match(stdout, /已暂停/);
  const captured = JSON.parse(await readFile(marker, "utf8"));
  assert.equal(captured.model, "openagi-config-own/my-model"); assert.deepEqual(captured.providers, ["openagi-config-own"]);
  assert.equal(captured.ownKey, true); assert.equal(captured.inheritedKey, false); assert.equal(captured.projectDisable, "1");
  assert(captured.home.includes(".openagi/runtime/home"));
  assert(captured.paths.every((p: string) => ["/api/info", "/api/plugin"].includes(p)));
  const state = await store.read(); assert.equal(state.project.models.worker?.modelID, "my-model"); assert.equal(state.project.models.dialogue?.modelID, "my-light");
  assert(!JSON.stringify(state).includes("own-fixture-key")); assert(!stdout.includes("own-fixture-key"));
  await assert.rejects(fetch(`http://127.0.0.1:${captured.port}/api/info`));
});
