import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acceptOpenagiLaunch, createOpenAGIBridge, initializeOpenagiNative } from "../src/upstream-bridge.js";

test("a launch received before desktop bootstrap is queued, selects its canonical project and prefills without resuming", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-launch-"));
  t.after(async () => { await (await createOpenAGIBridge()).close(); await rm(directory, { recursive: true, force: true }); });
  const previousRoot = process.env.OPENAGI_ROOT; process.env.OPENAGI_ROOT = directory;
  t.after(() => { if (previousRoot === undefined) delete process.env.OPENAGI_ROOT; else process.env.OPENAGI_ROOT = previousRoot; });
  const argv = ["OpenAGI", "--project", directory, "--summary", "Draft goal only"];
  await acceptOpenagiLaunch(argv);
  argv[2] = "relative-mutation";
  await initializeOpenagiNative({});
  const bridge = await createOpenAGIBridge(); const state = bridge.state(); const canonical = await realpath(directory);
  assert.equal(state.selectedProject, canonical);
  assert.equal(state.projects[0]?.directory, canonical);
  assert.equal(state.projects[0]?.draftSummary, "Draft goal only");
  assert.equal(state.projects[0]?.phase, "idle"); assert.equal(state.projects[0]?.summary, undefined);
  assert.deepEqual(state.sessions, []); assert.equal(state.servers[0]?.state, "stopped"); assert.equal(state.servers[0]?.http, undefined);
  await assert.rejects(readFile(join(directory, ".openagi/state.json")), { code: "ENOENT" });
});

test("second launches select a new project while missing launch values preserve state and closed bridges can reopen", async t => {
  const first = await mkdtemp(join(tmpdir(), "openagi-launch-a-")); const second = await mkdtemp(join(tmpdir(), "openagi-launch-b-"));
  t.after(async () => { await (await createOpenAGIBridge()).close(); await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]); });
  const previousRoot = process.env.OPENAGI_ROOT; process.env.OPENAGI_ROOT = first;
  t.after(() => { if (previousRoot === undefined) delete process.env.OPENAGI_ROOT; else process.env.OPENAGI_ROOT = previousRoot; });
  await initializeOpenagiNative({}); await acceptOpenagiLaunch(["--project", first]);
  const bridge = await createOpenAGIBridge();
  await acceptOpenagiLaunch(["OpenAGI", "--project", second, "--summary", "New draft"]);
  assert.equal(bridge.state().selectedProject, await realpath(second));
  assert.equal(bridge.state().projects.find(project => project.directory === bridge.state().selectedProject)?.draftSummary, "New draft");
  const before = bridge.state();
  for (const argv of [[], ["--project"], ["--summary", "Unscoped summary"]]) await acceptOpenagiLaunch(argv);
  assert.deepEqual(bridge.state(), before);
  assert.deepEqual(bridge.state().sessions, []); assert(bridge.state().projects.every(project => project.phase === "idle"));
  await bridge.close(); const next = await createOpenAGIBridge();
  assert.notEqual(next, bridge); assert.equal(next.closed, false); assert.deepEqual(next.state().projects, []);
});
