import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAGIBridge } from "../src/upstream-bridge.js";
import { configureOutboundProxy } from "../src/proxy.js";
import { BrowserConversation } from "../src/conversation.js";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-native-"));
  const previousRoot = process.env.OPENAGI_ROOT; process.env.OPENAGI_ROOT = directory;
  t.after(async () => { if (previousRoot === undefined) delete process.env.OPENAGI_ROOT; else process.env.OPENAGI_ROOT = previousRoot; });
  const bridge = new OpenAGIBridge();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, bridge };
}
async function waitFor(check: () => boolean) {
  const until = Date.now() + 2_000;
  while (!check()) { if (Date.now() > until) throw new Error("Native bridge did not settle"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test("opening a native project creates configuration only and never resumes a goal", async t => {
  const { directory, bridge } = await fixture(t);
  await bridge.project(directory);
  await bridge.prefill(directory, "Draft only");
  const state = bridge.state();
  assert.equal(state.projects[0]?.phase, "idle");
  assert.equal(state.projects[0]?.draftSummary, "Draft only");
  assert.equal(state.projects[0]?.summary, undefined);
  assert.deepEqual(state.sessions, []); assert.equal(state.servers[0]?.state, "stopped"); assert.equal(state.servers[0]?.http, undefined);
  const config = JSON.parse(await readFile(join(directory, ".openagi/config.json"), "utf8"));
  assert.equal(config.jev.type, "typesafe");
  await assert.rejects(readFile(join(directory, ".openagi/state.json")), { code: "ENOENT" });
  await assert.rejects(bridge.project("relative"), /absolute/);
});

test("native configuration pauses and project removal forgets only in-memory ownership", async t => {
  const { directory, bridge } = await fixture(t);
  await bridge.project(directory); await bridge.config(directory);
  await waitFor(() => !!bridge.state().projects[0]?.prompt);
  assert.equal(bridge.state().projects[0]?.phase, "configuring");
  await assert.rejects(bridge.run(directory, { summary: "Cannot overlap" }), /Pause/);
  await bridge.pause(directory);
  await waitFor(() => bridge.state().projects[0]?.phase === "idle");
  assert.equal(bridge.state().projects[0]?.prompt, undefined);
  await bridge.config(directory);
  await waitFor(() => !!bridge.state().projects[0]?.prompt);
  await bridge.forget(directory);
  assert.deepEqual(bridge.state(), { configuration: bridge.state().configuration, network: bridge.state().network, selectedProject: undefined, projects: [], servers: [], sessions: [] });
  assert.equal(JSON.parse(await readFile(join(directory, ".openagi/config.json"), "utf8")).version, 2);
  await assert.rejects(bridge.run(directory, { summary: "Removed" }), /project picker/);
  await waitFor(() => bridge.state().projects.length === 0);
  await bridge.project(directory);
  assert.equal(bridge.state().projects[0]?.phase, "idle");
  assert.equal(bridge.state().projects[0]?.prompt, undefined);
});

test("native conversation rejects stale answers, hides credentials and resolves aborts", async () => {
  const controller = new AbortController(); const io = new BrowserConversation(controller.signal);
  const key = io.secret("Key");
  assert.throws(() => io.answer("obsolete", "wrong"), /已结束/);
  io.answer(io.prompt!.id, "local-fixture-secret"); assert.equal(await key, "local-fixture-secret");
  io.write("echo local-fixture-secret"); assert(!JSON.stringify(io.messages).includes("local-fixture-secret"));
  const pending = io.ask("Next"); controller.abort(); assert.equal(await pending, null);
  assert.equal(io.prompt, undefined); assert.equal(await io.ask("Late"), null);
  const length = io.messages.length; io.write("Late result"); assert.equal(io.messages.length, length);
});

test("restoring native projects and session ownership never changes explicit selection or resumes a task", async t => {
  const { directory, bridge } = await fixture(t);
  const second = await mkdtemp(join(tmpdir(), "openagi-restore-"));
  t.after(() => rm(second, { recursive: true, force: true }));
  await bridge.project(directory);
  const selected = bridge.state().selectedProject!;
  await bridge.project(second, { select: false });
  assert.equal(bridge.state().selectedProject, selected);
  const { createHash } = await import("node:crypto");
  const serverId = `openagi:${createHash("sha256").update(selected).digest("hex").slice(0, 20)}`;
  let focused = 0; bridge.onSession(() => focused++);
  await bridge.rememberSessions([
    { serverId, directory: selected, sessionId: "ses_restore", mode: "build", label: "Worker", focus: true },
    { serverId: "openagi:another", directory: selected, sessionId: "ses_foreign", mode: "build", label: "Wrong owner" },
    { serverId, directory: selected, sessionId: "../invalid", mode: "observe", label: "Invalid" },
  ]);
  assert.deepEqual(bridge.state().sessions.map(s => [s.sessionId, s.focus]), [["ses_restore", false]]);
  assert.equal(focused, 0);
  assert(bridge.state().projects.every(project => project.phase === "idle" && !project.prompt));
  await bridge.forget(directory);
  assert.deepEqual(bridge.state().sessions, []);
});


test("workflow failures stay visible and redacted while awaiting recovery, then clear on retry", async () => {
  const controller = new AbortController(); const io = new BrowserConversation(controller.signal);
  io.activity("preparing");
  io.hide(["private-key"]); io.error("TypeSafe private-key HTTP 401");
  const pending = io.ask("处理后回车重试");
  assert.equal(io.failure, "TypeSafe [hidden] HTTP 401");
  assert.equal(io.stage, "preparing");
  assert.equal(io.prompt?.text, "处理后回车重试");
  io.answer(io.prompt!.id, ""); assert.equal(await pending, ""); assert.equal(io.failure, undefined);
  io.activity("implementing"); assert.equal(io.stage, "implementing");
  io.close(); assert.equal(io.stage, undefined);
  io.activity("validating"); assert.equal(io.stage, undefined);
});


test("native proxy settings work without a project, persist globally and do not start model execution", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-native-network-"));
  const original = { ...process.env }; const bridge = new OpenAGIBridge({ appData: directory });
  t.after(async () => {
    await bridge.close(); await rm(directory, { recursive: true, force: true });
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    configureOutboundProxy(original);
  });
  await bridge.initializeNetwork();
  assert.equal(bridge.state().network?.proxyURL, "http://127.0.0.1:7892");
  await bridge.networkConfig({ enabled: false, proxyURL: "http://127.0.0.1:8888", noProxy: "" });
  assert.equal(bridge.state().network?.enabled, false);
  assert.equal(JSON.parse(await readFile(join(directory, "network.json"), "utf8")).proxyURL, "http://127.0.0.1:8888");
  assert.deepEqual(bridge.state().projects, []); assert.deepEqual(bridge.state().sessions, []);
});


test("native project view shows the current goal as a user message and retains old goals only in storage", async t => {
  const { directory, bridge } = await fixture(t);
  const { InteractiveSession } = await import("../src/session.js");
  const { ProjectStore } = await import("../src/store.js");
  const store = new ProjectStore(directory);
  const io = new BrowserConversation(new AbortController().signal);
  const runtime = { run: async () => { throw new Error("Initialization must not call a model"); }, search: async () => [] };
  const session = new InteractiveSession(store, runtime, io);
  await session.initialize({ summary: "帮我做一个贪吃蛇", noChecks: true });
  await new Promise(resolve => setTimeout(resolve, 2));
  await session.initialize({ summary: "帮我做一个俄罗斯方块" });
  await bridge.project(directory);
  assert.deepEqual(bridge.state().projects[0]?.messages.filter(message => message.role === "user").map(message => message.text), ["帮我做一个俄罗斯方块"]);
  assert((await store.read()).conversation?.some(message => message.text === "帮我做一个贪吃蛇"));
  await session.initialize({ summary: "帮我做一个俄罗斯方块" });
  await bridge.project(directory);
  assert.equal(bridge.state().projects[0]?.messages.filter(message => message.role === "user").length, 1);
});
