import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageTracker } from "../src/usage.js";

test("usage follows paginated native model steps, updates snapshots once, and survives reopening", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let revision = 1;
  let available = true;
  let messageReads = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:fixture").toString("base64")}`);
    if (!available) { response.writeHead(503).end(); return; }
    const url = new URL(request.url!, "http://localhost");
    const tokens = { input: 100, output: revision === 1 ? 5 : 10, reasoning: 20, cache: { read: 30, write: 40 } };
    const model = { providerID: "openagi-config-primary", id: "heavy" };
    const session = (id: string, location: string) => ({ id, location: { directory: location }, time: { updated: revision } });
    const result = url.pathname === "/api/session"
      ? url.searchParams.has("cursor")
        ? { data: [session("ses_child", join(directory, ".openagi/worktrees/one")), session("ses_outside", directory + "-other")], cursor: {} }
        : { data: [session("ses_main", directory)], cursor: { next: "sessions-page-2" } }
      : url.pathname.includes("ses_child")
        ? { data: [{ id: "msg_child", type: "assistant", model: { ...model, id: "light" }, tokens: { ...tokens, input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }], cursor: {} }
        : url.searchParams.has("cursor")
          ? { data: [{ id: "msg_compact", type: "compaction", status: "completed", model: { ...model, providerID: "other" }, tokens }], cursor: {} }
          : { data: [{ id: "msg_main", type: "assistant", model, tokens }, { id: "msg_missing", type: "assistant", model }, { id: "msg_user", type: "user" }, { id: "msg_running", type: "compaction", status: "running" }], cursor: { next: "messages-page-2" } };
    if (url.pathname !== "/api/session") { messageReads++; assert(!url.pathname.includes("outside")); }
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
  });
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address = server.address(); assert(address && typeof address === "object");
  const endpoint = { url: `http://127.0.0.1:${address.port}`, password: "fixture" };
  const tracker = new UsageTracker(directory);
  await Promise.all([tracker.sync(endpoint), tracker.sync(endpoint)]);
  assert.equal(messageReads, 3);
  assert.equal(tracker.summary().total, 395);
  assert.equal(tracker.summary().requests, 4);
  assert.equal(tracker.summary().unreported, 1);
  assert.equal(tracker.summary().models.length, 3, "same model at different providers stays separate");
  await tracker.sync(endpoint); assert.equal(messageReads, 3, "unchanged sessions do not reread transcripts");
  revision++;
  await tracker.sync(endpoint);
  assert.equal(tracker.summary().total, 405, "streamed usage replaces the previous snapshot");
  await tracker.recordJev("jev-resolved", { input_tokens: 1000, output_tokens: 2 });
  await tracker.recordJev("jev-resolved", { input_tokens: 10, output_tokens: 1 });
  assert.equal(tracker.summary().total, 1418);
  assert.equal(tracker.summary().requests, 6);
  const saved = await readFile(join(directory, ".openagi/usage.jsonl"), "utf8");
  assert(!saved.includes("fixture"), "credentials never enter the ledger");
  const reopened = new UsageTracker(directory); await reopened.load();
  assert.deepEqual(reopened.summary().models, tracker.summary().models);
  await reopened.sync(endpoint);
  assert.equal(reopened.summary().total, 1418, "backfill after restart does not duplicate usage");
  available = false;
  await reopened.sync(endpoint);
  assert.equal(reopened.summary().error, "sync"); assert.equal(reopened.summary().total, 1418);
  available = true;
  await reopened.sync(endpoint); assert.equal(reopened.summary().error, undefined);
});
