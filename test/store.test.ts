import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { State } from "../src/domain.js";
import { ProjectStore } from "../src/store.js";

function stateFor(directory: string): State {
  return State.parse({
    version: 1, project: {
      name: "Store test", directory, modules: ["function-finder"],
      context: { goal: "Preserve state safely" }, opencode: {}, validation: { checks: [] },
    }, tasks: [],
  });
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-store-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new ProjectStore(directory), state: stateFor(directory) };
}

test("Store writes validated state atomically, limits file permissions and leaves no temporary files", async t => {
  const { store, state } = await fixture(t);
  assert.equal(await store.exists(), false);
  await store.withLock(() => store.write(state));
  assert.equal(await store.exists(), true);
  assert.deepEqual(await store.read(), state);
  assert.deepEqual(await readdir(dirname(store.file)), ["state.json"]);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  const changed = structuredClone(state);
  changed.project.name = "Updated project";
  await store.withLock(() => store.write(changed));
  assert.equal((await store.read()).project.name, "Updated project");
  assert.deepEqual(await readdir(dirname(store.file)), ["state.json"]);
});

test("Store rejects writes outside a lock and invalid writes preserve previous state", async t => {
  const { store, state } = await fixture(t);
  await assert.rejects(store.write(state), /require a project lock/);
  await store.withLock(() => store.write(state));
  const original = await readFile(store.file, "utf8");
  const invalid = { ...state, version: 2 } as unknown as State;
  await assert.rejects(store.withLock(() => store.write(invalid)));
  assert.equal(await readFile(store.file, "utf8"), original);
  assert.deepEqual(await readdir(dirname(store.file)), ["state.json"]);
});

test("Store rejects state belonging to a different project on both read and write", async t => {
  const { store, state } = await fixture(t);
  const foreign = { ...state, project: { ...state.project, directory: join(store.directory, "different-project") } };
  await assert.rejects(store.withLock(() => store.write(foreign)), /another directory/);
  await store.withLock(() => store.write(state));
  await writeFile(store.file, JSON.stringify(foreign));
  await assert.rejects(store.read(), /another directory/);
});

test("Store refuses malformed persisted state", async t => {
  const { store, state } = await fixture(t);
  await store.withLock(() => store.write(state));
  await writeFile(store.file, "{not valid JSON}");
  await assert.rejects(store.read(), SyntaxError);
  await writeFile(store.file, JSON.stringify({ ...state, project: { ...state.project, modules: [] } }));
  await assert.rejects(store.read());
});

test("Store lock spans asynchronous operations and rejects a competing store instance", async t => {
  const { directory, store, state } = await fixture(t);
  const competitor = new ProjectStore(directory);
  let release!: () => void;
  let signalAcquired!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const acquired = new Promise<void>(resolve => { signalAcquired = resolve; });
  let competingOperationRan = false;
  const first = store.withLock(async () => { signalAcquired(); await gate; await store.write(state); });
  await acquired;
  try {
    await assert.rejects(competitor.withLock(async () => { competingOperationRan = true; }), /Another OpenAGI operation holds/);
    assert.equal(competingOperationRan, false);
    await assert.rejects(store.withLock(async () => {}), /Nested project locks/);
  } finally { release(); }
  await first;
  assert.equal((await competitor.read()).project.name, state.project.name);
  let nextOperationRan = false;
  await competitor.withLock(async () => { nextOperationRan = true; });
  assert.equal(nextOperationRan, true);
});

test("Store releases its lock after an operation throws", async t => {
  const { store, state } = await fixture(t);
  await assert.rejects(store.withLock(async () => { throw new Error("research failed"); }), /research failed/);
  await store.withLock(() => store.write(state));
  assert.deepEqual(await readdir(dirname(store.file)), ["state.json"]);
});

test("Store validates lock metadata before running an operation", async t => {
  const { store, state } = await fixture(t);
  await store.withLock(() => store.write(state));
  await writeFile(join(dirname(store.file), "lock.json"), JSON.stringify({ pid: -1, token: "broken" }));
  let ran = false;
  await assert.rejects(store.withLock(async () => { ran = true; }), /Invalid project lock/);
  assert.equal(ran, false);
  assert.equal((await store.read()).project.name, state.project.name);
});

test("Store recovers a stale lock only after verifying the owner process is gone", async t => {
  const { store, state } = await fixture(t);
  await store.withLock(() => store.write(state));
  const absentPid = 2_147_483_647;
  assert.throws(() => process.kill(absentPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  await writeFile(join(dirname(store.file), "lock.json"), JSON.stringify({ pid: absentPid, token: "abandoned" }));
  let ran = false;
  await store.withLock(async () => { ran = true; await store.write(state); });
  assert.equal(ran, true);
  assert.deepEqual(await readdir(dirname(store.file)), ["state.json"]);
});
