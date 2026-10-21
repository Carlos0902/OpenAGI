import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { OpenCodeError, OpenCodeRuntime } from "../src/opencode.js";

type Call = { method: string; url: URL; body: Record<string, unknown>; headers: IncomingHttpHeaders };
type Response = { status?: number; body?: unknown; delayMs?: number; bodyDelayMs?: number; waitFor?: Promise<void> };
const sessionId = "ses_fixture";
const promptId = "msg_prompt";

async function fixture(t: TestContext, handler: (call: Call) => Response | undefined, options: ConstructorParameters<typeof OpenCodeRuntime>[0] = {}) {
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const call: Call = { method: request.method!, url: new URL(request.url!, "http://fixture"), body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}, headers: request.headers };
    calls.push(call);
    const result = handler(call) ?? standard(call);
    if (result.waitFor) await result.waitFor;
    if (result.delayMs) await delay(result.delayMs);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    const body = result.body === undefined ? undefined : JSON.stringify(result.body);
    if (result.bodyDelayMs && body) { response.write(body.slice(0, 1)); await delay(result.bodyDelayMs); response.end(body.slice(1)); }
    else response.end(body);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  assert(address && typeof address === "object");
  t.after(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { calls, baseUrl, runtime: new OpenCodeRuntime({ baseUrl, pollIntervalMs: 5, timeoutMs: 2_000, ...options }) };
}

function standard(call: Call): Response {
  const path = call.url.pathname;
  if (path === "/api/info") return { body: { version: "2.0.26", pid: 1, urls: [], paths: { tmp: "/tmp" } } };
  if (path === "/api/session" && call.method === "POST") return { body: { data: { id: sessionId, location: { directory: "/project" } } } };
  if (path === "/api/session" && call.method === "GET") return { body: { data: [], cursor: {} } };
  if (path === "/api/session/active") return { body: { data: {} } };
  if (path === `/api/session/${sessionId}` && call.method === "GET") return { body: { data: { id: sessionId, location: { directory: "/project" } } } };
  if (path.endsWith("/prompt")) return { body: { data: { id: promptId, sessionID: sessionId, type: "user", delivery: "steer", payload: { text: call.body.text }, time: { created: Date.now() } } } };
  if (path.endsWith("/wait") || call.method === "PATCH" || path.endsWith("/model")) return { status: 204 };
  if (path.endsWith("/interrupt")) return { body: { interrupted: true } };
  if (path.endsWith("/permission") || path.endsWith("/form")) return { body: { data: [] } };
  if (path.endsWith("/message")) return { body: completed() };
  return { status: 404, body: { message: `Unhandled fixture ${call.method} ${path}` } };
}

function completed(outcome: "succeeded" | "failed" | "interrupted" = "succeeded") {
  return { data: [
    { id: "msg_idle", type: "idle", outcome, ...(outcome === "failed" ? { error: { message: "Provider rejected the request" } } : {}), time: { created: 3 } },
    { id: "msg_answer", type: "assistant", content: [{ type: "reasoning", text: "Private reasoning" }, { type: "text", text: '{"tasks":[]}' }], time: { created: 2, completed: 3 } },
    { id: promptId, type: "user", text: "inspect", time: { created: 1 } },
  ], cursor: { next: null, previous: null } };
}

test("v2 admission, idle completion, readonly rules, model mapping and basic authentication", async (t) => {
  const { runtime, calls } = await fixture(t, () => undefined, { username: "opencode", password: "fixture-secret" });
  assert.deepEqual(await runtime.run({ directory: "/project", mode: "observe", prompt: "inspect", model: { providerID: "example", modelID: "smart", variant: "high" } }), { sessionId, text: '{"tasks":[]}' });
  const create = calls.find((call) => call.method === "POST" && call.url.pathname === "/api/session")!;
  assert.deepEqual(create.body.model, { providerID: "example", id: "smart", variant: "high" });
  assert.deepEqual(create.body.location, { directory: "/project" });
  const permissions = create.body.permissions as { action: string; effect: string }[];
  assert.deepEqual(permissions[0], { action: "*", resource: "*", effect: "deny" });
  assert(permissions.some((rule) => rule.action === "read" && rule.effect === "allow"));
  assert(!permissions.some((rule) => ["shell", "edit", "subagent"].includes(rule.action) && rule.effect === "allow"));
  assert.equal(create.headers.authorization, `Basic ${Buffer.from("opencode:fixture-secret").toString("base64")}`);
  assert.deepEqual(calls.find((call) => call.url.pathname.endsWith("/prompt"))!.body, { text: "inspect", delivery: "steer", resume: true, metadata: { displayText: "observe", comments: [], collapsed: true } });
  assert(calls.some((call) => call.url.pathname === `/api/experimental/session/${sessionId}/wait`));
});

test("rejects v1 before creating a session", async (t) => {
  const { runtime, calls } = await fixture(t, (call) => call.url.pathname === "/api/info" ? { body: { version: "1.2.3" } } : undefined);
  await assert.rejects(runtime.run({ directory: "/project", prompt: "inspect", mode: "build" }), (error: unknown) => error instanceof OpenCodeError && error.kind === "version");
  assert.equal(calls.length, 1);
});

test("the native workflow container restores by verified ownership without admitting or executing a prompt", async t => {
  const { runtime, calls } = await fixture(t, call => call.method === "GET" && call.url.pathname === `/api/session/${sessionId}` ? { body: { data: { id: sessionId, location: { directory: "/project" }, metadata: { openagi: { kind: "workflow", directory: "/project" } } } } } : undefined);
  assert.equal(await runtime.workflowSession("/project", "OpenAGI · Project"), sessionId);
  const create = calls.find(call => call.method === "POST" && call.url.pathname === "/api/session")!;
  assert.deepEqual(create.body.metadata, { openagi: { kind: "workflow", directory: "/project" } });
  assert.deepEqual(create.body.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  assert.equal(await runtime.workflowSession("/project", "OpenAGI · Project", sessionId), sessionId);
  assert.equal(calls.filter(call => call.method === "POST" && call.url.pathname === "/api/session").length, 1);
  assert(!calls.some(call => /\/(prompt|wait|interrupt)$/.test(call.url.pathname)));
  await assert.rejects(runtime.workflowSession("/other", "Wrong", sessionId), /different project/);
});

test("workflow modules keep native worktree context and shared parent metadata without taking a parent model context", async t => {
  const { runtime, calls } = await fixture(t, () => undefined, { workflow: { mainSessionId: "ses_main", directory: "/project" } });
  await runtime.run({ directory: "/project/.openagi/worktrees/task", mode: "build", label: "Worker · Feature", prompt: "Implement" });
  const create = calls.find(call => call.method === "POST" && call.url.pathname === "/api/session")!;
  assert.deepEqual(create.body.location, { directory: "/project/.openagi/worktrees/task" });
  assert.equal(create.body.parentID, undefined);
  assert.deepEqual(create.body.metadata, { openagi: { kind: "module", mainSessionId: "ses_main", directory: "/project", mode: "build", label: "Worker · Feature" } });
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
});

test("a missing workflow pointer recovers the existing owned native view without creating a duplicate", async t => {
  const { runtime, calls } = await fixture(t, call => call.method === "GET" && call.url.pathname === "/api/session" ? { body: { data: [
    { id: "ses_unrelated", location: { directory: "/other" }, metadata: { openagi: { kind: "workflow", directory: "/other" } } },
    { id: "ses_kept", location: { directory: "/project" }, metadata: { openagi: { kind: "workflow", directory: "/project" } } },
  ], cursor: {} } } : undefined);
  assert.equal(await runtime.workflowSession("/project", "OpenAGI · Project"), "ses_kept");
  assert(!calls.some(call => call.method === "POST"));
  assert.equal(calls.find(call => call.method === "PATCH")?.url.pathname, "/api/session/ses_kept");
});

test("legacy session association verifies actual directory before metadata update or project membership", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "openagi-member-boundary-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const project = join(temporary, "project"), foreign = join(temporary, "other-project");
  await Promise.all([mkdir(project), mkdir(foreign)]);
  const { runtime, calls } = await fixture(t, call => call.method === "GET" && call.url.pathname === `/api/session/${sessionId}` ? { body: { data: { id: sessionId, location: { directory: foreign }, metadata: { userOwned: true } } } } : undefined);
  await assert.rejects(runtime.linkWorkflowSession(sessionId, { mainSessionId: "ses_main", directory: project, mode: "build", label: "Worker" }), /超出|outside/i);
  assert(!calls.some(call => call.method === "PATCH" || call.url.pathname.endsWith("/prompt")));
});

test("structured orchestration replies are marked for native folding while retaining raw output", async t => {
  const { runtime, calls } = await fixture(t, () => undefined);
  const reply = await runtime.run({ directory: "/project", mode: "judge", label: "Collector", resultKeys: ["groups"], prompt: "consolidate" });
  const admitted = calls.find(call => call.url.pathname.endsWith("/prompt"))!;
  assert.deepEqual(admitted.body.metadata, { displayText: "Collector", comments: [], collapsed: true, resultPresentation: { keys: ["groups"] } });
  assert.equal(admitted.body.text, "consolidate");
  assert.equal(reply.text, '{"tasks":[]}');
});

test("build mode preserves upstream agent permissions and reused sessions get current restrictions", async (t) => {
  const { runtime, calls } = await fixture(t, () => undefined);
  await runtime.run({ directory: "/project", prompt: "build", mode: "build" });
  assert.deepEqual(calls.find((call) => call.url.pathname === "/api/session" && call.method === "POST")!.body.permissions, []);
  await runtime.run({ directory: "/project", prompt: "judge", mode: "judge", sessionId, model: { providerID: "example", modelID: "judge" } });
  assert(calls.some((call) => call.method === "PATCH" && Array.isArray(call.body.permissions) && call.body.permissions.length > 0));
  assert.deepEqual(calls.find((call) => call.url.pathname.endsWith("/model"))!.body, { model: { providerID: "example", id: "judge" } });
});

test("reused sessions cannot silently move work into another directory", async (t) => {
  const { runtime, calls } = await fixture(t, () => undefined);
  await assert.rejects(runtime.run({ directory: "/other", prompt: "build", mode: "build", sessionId }), (error: unknown) => error instanceof OpenCodeError && error.kind === "session");
  assert(!calls.some((call) => call.url.pathname.endsWith("/prompt")));
});

test("retrying a pending or active session never admits a duplicate prompt or changes its permissions", async (t) => {
  const pending = await fixture(t, (call) => call.url.pathname.endsWith("/permission") ? { body: { data: [{ id: "per_pending" }] } } : undefined);
  await assert.rejects(pending.runtime.run({ directory: "/project", prompt: "retry", mode: "build", sessionId }), (error: unknown) => error instanceof OpenCodeError && error.kind === "pending");
  assert(!pending.calls.some((call) => call.method === "PATCH" || call.url.pathname.endsWith("/prompt")));
  const active = await fixture(t, (call) => call.url.pathname === "/api/session/active" ? { body: { data: { [sessionId]: { type: "running" } } } } : undefined);
  await assert.rejects(active.runtime.run({ directory: "/project", prompt: "retry", mode: "build", sessionId }), (error: unknown) => error instanceof OpenCodeError && error.kind === "session");
  assert(!active.calls.some((call) => call.method === "PATCH" || call.url.pathname.endsWith("/prompt")));
});

test("surfaces pending permissions and forms with their reusable session", async (t) => {
  const { runtime, calls } = await fixture(t, (call) => {
    if (call.url.pathname.endsWith("/wait")) return { status: 204, delayMs: 100 };
    if (call.url.pathname.endsWith("/permission")) return { body: { data: [{ id: "per_fixture", sessionID: sessionId, action: "read", resources: [".env"] }] } };
    if (call.url.pathname.endsWith("/form")) return { body: { data: [{ id: "frm_fixture", sessionID: sessionId, title: "Choose behavior", fields: [{ key: "value", type: "string" }] }] } };
    return undefined;
  });
  await assert.rejects(runtime.run({ directory: "/project", prompt: "build", mode: "build" }), (error: unknown) => {
    assert(error instanceof OpenCodeError);
    assert.equal(error.kind, "pending"); assert.equal(error.sessionId, sessionId);
    assert.match(error.message, /per_fixture/); assert.match(error.message, /frm_fixture/);
    assert.equal(error.pending?.permissions.length, 1); assert.equal(error.pending?.forms.length, 1);
    return true;
  });
  assert(!calls.some((call) => call.url.pathname.endsWith("/interrupt")));
});

test("interactive permission and form replies continue the admitted prompt without duplication", async t => {
  let permissionPending = true; let formPending = true;
  const { runtime, calls } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/permission")) return { body: { data: permissionPending ? [{ id: "per_interactive", action: "shell", resources: ["npm test"] }] : [] } };
    if (call.url.pathname.endsWith("/form")) return { body: { data: formPending ? [{ id: "frm_interactive", title: "Scope", fields: [{ key: "scope", type: "string" }] }] : [] } };
    if (call.url.pathname.endsWith("/permission/per_interactive/reply")) { assert.deepEqual(call.body, { decision: "once" }); permissionPending = false; return { status: 204 }; }
    if (call.url.pathname.endsWith("/form/frm_interactive/reply")) { assert.deepEqual(call.body, { answer: { scope: "export" } }); formPending = false; return { status: 204 }; }
    return undefined;
  }, { onInteraction: async pending => {
    assert.equal(pending.sessionId, sessionId);
    return [{ kind: "permission", id: "per_interactive", decision: "once" }, { kind: "form", id: "frm_interactive", answer: { scope: "export" } }];
  } });
  assert.equal((await runtime.run({ directory: "/project", mode: "build", prompt: "implement" })).text, '{"tasks":[]}');
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert(!calls.some(call => call.url.pathname.endsWith("/interrupt")));
});

test("interactive resume waits for an active previous drain before submitting a continuation", async t => {
  let activeReads = 0;
  const { runtime, calls } = await fixture(t, call => call.url.pathname === "/api/session/active" ? { body: { data: activeReads++ < 2 ? { [sessionId]: { type: "running" } } : {} } } : undefined,
    { onInteraction: async () => [] });
  await runtime.run({ directory: "/project", mode: "build", prompt: "continue", sessionId });
  assert(activeReads >= 3);
  const admission = calls.findIndex(call => call.url.pathname.endsWith("/prompt"));
  assert.equal(calls.slice(0, admission).filter(call => call.url.pathname === "/api/session/active").length, 3);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
});

test("interactive callbacks cannot authorize unknown request IDs", async t => {
  const { runtime, calls } = await fixture(t, call => call.url.pathname.endsWith("/permission") ? { body: { data: [{ id: "per_known" }] } } : undefined,
    { onInteraction: async () => [{ kind: "permission", id: "per_invented", decision: "once" }] });
  await assert.rejects(runtime.run({ directory: "/project", mode: "build", prompt: "implement" }), /does not match/);
  assert(!calls.some(call => call.url.pathname.includes("/reply")));
});

test("native client receives the real session before execution and alone answers its permissions and forms", async t => {
  let permissionPending = true; let formPending = true;
  const notifications: { sessionId: string; directory: string; mode: string; purpose?: string; label: string }[] = [];
  let resolveSession!: () => void;
  const sessionReady = new Promise<void>(ready => { resolveSession = ready; });
  const { runtime, calls, baseUrl } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/permission")) return { body: { data: permissionPending ? [{ id: "per_native", sessionID: sessionId, action: "read", resources: ["README.md"] }] : [] } };
    if (call.url.pathname.endsWith("/form")) return { body: { data: formPending ? [{ id: "frm_native", sessionID: sessionId, title: "Scope", fields: [{ key: "scope", type: "string" }] }] : [] } };
    if (call.url.pathname.endsWith("/permission/per_native/reply")) {
      assert.equal(call.headers["x-native-client"], "original-ui"); assert.deepEqual(call.body, { decision: "once" }); permissionPending = false; return { status: 204 };
    }
    if (call.url.pathname.endsWith("/form/frm_native/reply")) {
      assert.equal(call.headers["x-native-client"], "original-ui"); assert.deepEqual(call.body, { answer: { scope: "basic" } }); formPending = false; return { status: 204 };
    }
    return undefined;
  }, { timeoutMs: 400, nativeInteractions: true, onSession: session => { notifications.push(session); resolveSession(); } });
  let finished = false;
  const run = runtime.run({ directory: "/project", mode: "build", label: "Worker", prompt: "implement" }).then(reply => { finished = true; return reply; });
  await sessionReady;
  assert.deepEqual(notifications, [{ sessionId, directory: "/project", mode: "build", purpose: undefined, label: "Worker" }]);
  assert.equal(calls.find(call => call.method === "POST" && call.url.pathname === "/api/session")?.body.title, "Worker");
  assert(!calls.some(call => call.url.pathname.endsWith("/prompt")), "Session registration precedes prompt admission so the original UI can subscribe in time");
  while (!calls.some(call => call.url.pathname.endsWith("/permission"))) await delay(2);
  await delay(700);
  assert.equal(finished, false, "A resolved upstream wait must not bypass native pending interactions");
  assert(!calls.some(call => call.url.pathname.endsWith("/reply") || call.url.pathname.endsWith("/interrupt")));
  const renewal = calls.find(call => call.method === "PATCH" && call.body.metadata && (call.body.metadata as { openagiInteraction?: unknown }).openagiInteraction);
  assert(renewal, "A waiting session publishes a real metadata event so v2's inactivity eviction cannot cancel its form");
  for (const [path, body] of [
    [`/api/session/${sessionId}/permission/per_native/reply`, { decision: "once" }],
    [`/api/session/${sessionId}/form/frm_native/reply`, { answer: { scope: "basic" } }],
  ] as const) {
    const response = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json", "x-native-client": "original-ui" }, body: JSON.stringify(body) });
    assert.equal(response.status, 204);
  }
  assert.equal((await run).text, '{"tasks":[]}');
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/reply")).length, 2);
  assert(!calls.some(call => call.url.pathname.endsWith("/interrupt")));
});

test("resuming an existing role updates its original native title before registering the session", async t => {
  let observedTitle: string | undefined;
  const { runtime, calls } = await fixture(t, call => {
    if (call.method === "PATCH" && typeof call.body.title === "string") observedTitle = call.body.title;
    return undefined;
  }, { onSession: () => assert.equal(observedTitle, `Validator · ${"task".repeat(40)}`.slice(0, 100)) });
  await runtime.run({ directory: "/project", mode: "judge", sessionId, label: `Validator · ${"task".repeat(40)}`, prompt: "Validate fixture" });
  const title = calls.findIndex(call => call.method === "PATCH" && typeof call.body.title === "string");
  const prompt = calls.findIndex(call => call.url.pathname.endsWith("/prompt"));
  assert(title >= 0 && title < prompt);
});

test("pausing while the native client has a pending request interrupts the admitted execution", async t => {
  const controller = new AbortController();
  const { runtime, calls } = await fixture(t, call => call.url.pathname.endsWith("/form") ? { body: { data: [{ id: "frm_native_pause" }] } } : undefined,
    { nativeInteractions: true, signal: controller.signal });
  const run = runtime.run({ directory: "/project", mode: "build", prompt: "implement" });
  while (!calls.some(call => call.url.pathname.endsWith("/form"))) await delay(2);
  controller.abort();
  await assert.rejects(run, (error: unknown) => error instanceof OpenCodeError && error.kind === "aborted" && error.sessionId === sessionId);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 1);
  assert(!calls.some(call => call.url.pathname.endsWith("/reply")), "Pause cannot answer a native question or permission on the user's behalf");
});

test("failed idle transitions are not accepted as successful answers", async (t) => {
  const { runtime } = await fixture(t, (call) => call.url.pathname.endsWith("/message") ? { body: completed("failed") } : undefined);
  await assert.rejects(runtime.run({ directory: "/project", prompt: "build", mode: "build" }), (error: unknown) => error instanceof OpenCodeError && error.kind === "failed" && error.sessionId === sessionId);
});

test("wait finishing before delivery does not reuse an old answer; reads pagination to the prompt", async (t) => {
  let reads = 0;
  const { runtime, calls } = await fixture(t, (call) => {
    if (!call.url.pathname.endsWith("/message")) return undefined;
    if (call.url.searchParams.has("cursor")) return { body: { data: completed().data.slice(2), cursor: {} } };
    reads++;
    if (reads === 1) return { body: { data: [{ id: "msg_previous_idle", type: "idle", outcome: "succeeded" }], cursor: {} } };
    return { body: { data: completed().data.slice(0, 2), cursor: { next: "next-page" } } };
  });
  assert.equal((await runtime.run({ directory: "/project", prompt: "build", mode: "build" })).text, '{"tasks":[]}');
  const next = calls.find((call) => call.url.searchParams.get("cursor") === "next-page")!;
  assert.equal(next.url.searchParams.has("order"), false);
});

test("a long idle wait rejoins after Undici's header deadline without interrupting or readmitting the Worker", async t => {
  const original = getGlobalDispatcher();
  const agent = new Agent();
  const dispatched: { path: string; headersTimeout?: number | null; bodyTimeout?: number | null }[] = [];
  // Accelerate the same real parser timeout that normally expires after 300 s.
  setGlobalDispatcher(agent.compose(dispatch => (options, handler) => {
    dispatched.push({ path: options.path, headersTimeout: options.headersTimeout, bodyTimeout: options.bodyTimeout });
    return dispatch({ ...options, headersTimeout: 40 }, handler);
  }));
  t.after(async () => { setGlobalDispatcher(original); await agent.destroy(); });
  let injectedCalls = 0;
  let idleAt: number | undefined;
  const { runtime, calls, baseUrl } = await fixture(t, call => {
    if (call.url.pathname === "/probe") return { status: 204, delayMs: 1_400 };
    if (call.url.pathname.endsWith("/wait")) {
      idleAt ??= Date.now() + 1_400;
      return { status: 204, delayMs: Math.max(0, idleAt - Date.now()) };
    }
    return undefined;
  }, {
    timeoutMs: 5_000, pollIntervalMs: 20, nativeInteractions: true,
    fetch: (input, init) => { injectedCalls++; return fetch(input, init); },
  });
  await assert.rejects(fetch(`${baseUrl}/probe`), (error: unknown) =>
    error instanceof TypeError && (error.cause as { code?: string } | undefined)?.code === "UND_ERR_HEADERS_TIMEOUT");
  assert.equal((await runtime.run({ directory: "/project", mode: "build", prompt: "Long Worker fixture" })).text, '{"tasks":[]}');
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert(calls.filter(call => call.url.pathname.endsWith("/wait")).length > 1, "A timed-out read-only waiter rejoins the existing execution");
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 0);
  assert(calls.filter(call => call.url.pathname.endsWith("/form")).length > 1, "Native forms remain polled while waiting for Worker completion");
  assert.equal(injectedCalls, calls.length - 1, "The configured fetch function still handles every runtime request");
  const waits = dispatched.filter(call => call.path.endsWith("/wait"));
  assert.equal(waits.length, calls.filter(call => call.url.pathname.endsWith("/wait")).length, "The existing global dispatcher still routes every long wait");
  assert(dispatched.every(call => call.headersTimeout !== 0 && call.bodyTimeout !== 0), "Fetch dispatchers and transport deadlines remain unchanged");
  t.diagnostic(`Verified long-wait retry with Node ${process.versions.node}, Electron ${process.versions.electron ?? "none"}, bundled Undici ${process.versions.undici}`);
});

test("a timed-out idle response body also rejoins without interrupting the admitted execution", async t => {
  const original = getGlobalDispatcher();
  const agent = new Agent();
  setGlobalDispatcher(agent.compose(dispatch => (options, handler) => dispatch({ ...options, bodyTimeout: 40 }, handler)));
  t.after(async () => { setGlobalDispatcher(original); await agent.destroy(); });
  let idleAt: number | undefined;
  const { runtime, calls, baseUrl } = await fixture(t, call => {
    if (call.url.pathname === "/probe") return { body: {}, bodyDelayMs: 1_400 };
    if (call.url.pathname.endsWith("/wait")) {
      idleAt ??= Date.now() + 1_400;
      return { body: {}, bodyDelayMs: Math.max(0, idleAt - Date.now()) };
    }
    return undefined;
  }, { timeoutMs: 5_000, pollIntervalMs: 20 });
  await assert.rejects(fetch(`${baseUrl}/probe`).then(response => response.json()), (error: unknown) =>
    error instanceof TypeError && (error.cause as { code?: string } | undefined)?.code === "UND_ERR_BODY_TIMEOUT");
  assert.equal((await runtime.run({ directory: "/project", mode: "build", prompt: "Long response body fixture" })).text, '{"tasks":[]}');
  assert(calls.filter(call => call.url.pathname.endsWith("/wait")).length > 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 0);
});

test("canceling transport-wait retries still interrupts once and confirms cleanup", async t => {
  const controller = new AbortController();
  let interrupted = false;
  let waits = 0;
  const { runtime, calls } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/interrupt")) interrupted = true;
    return undefined;
  }, {
    signal: controller.signal,
    fetch: (input, init) => {
      if (String(input).endsWith("/wait") && !interrupted) {
        if (++waits === 1) setTimeout(() => controller.abort(), 20);
        return Promise.reject(new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }));
      }
      return fetch(input, init);
    },
  });
  await assert.rejects(runtime.run({ directory: "/project", mode: "build", prompt: "Cancel retried waiter" }), (error: unknown) =>
    error instanceof OpenCodeError && error.kind === "aborted" && !error.message.includes("settlement could not be confirmed"));
  assert(waits > 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 1);
  const interrupt = calls.findIndex(call => call.url.pathname.endsWith("/interrupt"));
  assert(calls.slice(interrupt + 1).some(call => call.url.pathname.endsWith("/wait")));
});

test("other wait transport errors remain visible instead of retrying indefinitely", async t => {
  let interrupted = false;
  let failedWaits = 0;
  const { runtime, calls } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/interrupt")) interrupted = true;
    return undefined;
  }, {
    fetch: (input, init) => {
      if (String(input).endsWith("/wait") && !interrupted) {
        failedWaits++;
        return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
      }
      return fetch(input, init);
    },
  });
  await assert.rejects(runtime.run({ directory: "/project", mode: "build", prompt: "Visible broken connection" }), (error: unknown) =>
    error instanceof OpenCodeError && error.kind === "transport" && error.message.includes("ECONNRESET"));
  assert.equal(failedWaits, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 1);
});

test("timeout interrupts remote execution and exposes the session ID", async (t) => {
  const { runtime, calls } = await fixture(t, (call) => call.url.pathname.endsWith("/wait") ? { status: 204, delayMs: 200 } : undefined, { timeoutMs: 40 });
  await assert.rejects(runtime.run({ directory: "/project", prompt: "build", mode: "build" }), (error: unknown) => error instanceof OpenCodeError && error.kind === "timeout" && error.sessionId === sessionId);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 1);
});

test("explicit abort interrupts an admitted session", async (t) => {
  const controller = new AbortController();
  const { runtime, calls } = await fixture(t, (call) => {
    if (call.url.pathname.endsWith("/wait")) { setTimeout(() => controller.abort(), 10); return { status: 204, delayMs: 100 }; }
    return undefined;
  }, { signal: controller.signal });
  await assert.rejects(runtime.run({ directory: "/project", prompt: "build", mode: "build" }), (error: unknown) => error instanceof OpenCodeError && error.kind === "aborted");
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/interrupt")).length, 1);
});

test("abort acknowledges only after the original wait API confirms interruption cleanup has settled", async t => {
  const controller = new AbortController();
  let releaseInitial!: () => void; let releaseIdle!: () => void; let observeInitial!: () => void; let observeIdle!: () => void;
  const initialWait = new Promise<void>(resolve => { releaseInitial = resolve; });
  const idleWait = new Promise<void>(resolve => { releaseIdle = resolve; });
  const initialSeen = new Promise<void>(resolve => { observeInitial = resolve; });
  const idleSeen = new Promise<void>(resolve => { observeIdle = resolve; });
  t.after(() => { releaseInitial(); releaseIdle(); });
  let interrupts = 0;
  const { runtime, calls } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/interrupt")) { interrupts++; assert.deepEqual(call.body, { resume: false }); return { body: { interrupted: true } }; }
    if (call.url.pathname.endsWith("/wait")) {
      if (!interrupts) { observeInitial(); return { status: 204, waitFor: initialWait }; }
      observeIdle(); return { status: 204, waitFor: idleWait };
    }
    return undefined;
  }, { signal: controller.signal, nativeInteractions: true });
  let returned = false;
  const run = runtime.run({ directory: "/project", mode: "build", prompt: "fixture pending work" });
  const rejected = run.catch(error => { returned = true; throw error; });
  // Attach the rejection assertion before resolving cleanup to avoid an unhandled rejection.
  const checked = assert.rejects(rejected, (error: unknown) => error instanceof OpenCodeError && error.kind === "aborted" && error.sessionId === sessionId);
  await initialSeen; controller.abort(); await idleSeen;
  assert.equal(returned, false, "Interrupt acceptance alone must not let desktop shutdown kill the still-settling execution");
  releaseIdle(); await checked;
  const interrupt = calls.findIndex(call => call.url.pathname.endsWith("/interrupt"));
  assert(calls.slice(interrupt + 1).some(call => call.url.pathname.endsWith("/wait")));
  assert.equal(interrupts, 1);
});

test("a failed interruption settlement is reported instead of claiming the execution is safely idle", async t => {
  const controller = new AbortController(); let interrupted = false;
  const { runtime } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/interrupt")) { interrupted = true; return { body: { interrupted: true } }; }
    if (call.url.pathname.endsWith("/wait")) {
      if (interrupted) return { status: 503, body: { message: "Cleanup unavailable" } };
      setTimeout(() => controller.abort(), 5); return { status: 204, delayMs: 100 };
    }
    return undefined;
  }, { signal: controller.signal });
  await assert.rejects(runtime.run({ directory: "/project", mode: "build", prompt: "fixture" }), /remote interruption settlement could not be confirmed/);
});

test("a lost prompt-admission response still interrupts the known session", async (t) => {
  const { runtime, calls } = await fixture(t, (call) => call.url.pathname.endsWith("/prompt") ? { ...standard(call), delayMs: 200 } : undefined, { timeoutMs: 40 });
  await assert.rejects(runtime.run({ directory: "/project", prompt: "build", mode: "build" }), (error: unknown) => error instanceof OpenCodeError && error.kind === "timeout" && error.sessionId === sessionId);
  assert(calls.some((call) => call.url.pathname.endsWith("/interrupt")));
});

test("web search reuses the v2 provider API and propagates failure", async (t) => {
  const { runtime, calls } = await fixture(t, (call) => call.url.pathname === "/api/websearch" ? { body: { location: { directory: "/project" }, data: { providerID: "tinyfish", results: [{ url: "https://example.com/paper", title: "Paper", content: "Evidence", time: { published: 123 } }, { url: "https://example.com/docs", title: null, content: null, time: { published: null } }] } } } : undefined);
  assert.deepEqual(await runtime.search({ directory: "/project", query: "similar algorithms", limit: 1 }), [{ url: "https://example.com/paper", title: "Paper", description: "Evidence", publishedAt: 123 }]);
  const search = calls.find((call) => call.url.pathname === "/api/websearch")!;
  assert.equal(search.url.searchParams.get("location[directory]"), "/project");
  assert.deepEqual(search.body, { query: "similar algorithms" });
  assert.deepEqual((await runtime.search({ directory: "/project", query: "docs", limit: 2 }))[1], { url: "https://example.com/docs", title: "https://example.com/docs", description: "" });
  const failed = await fixture(t, (call) => call.url.pathname === "/api/websearch" ? { status: 503, body: { message: "Provider unavailable" } } : undefined);
  await assert.rejects(failed.runtime.search({ directory: "/project", query: "research" }), /Provider unavailable/);
});


test("interrupted Worker replies preserve the actual unanswered question instead of reporting no details", async t => {
  const { runtime, calls } = await fixture(t, call => {
    if (call.url.pathname.endsWith("/message")) return { body: { data: [
      { id: "msg_idle", type: "idle", outcome: "interrupted" },
      { id: "msg_question", type: "assistant", error: { type: "aborted", message: "Step interrupted" }, content: [{ type: "tool", name: "question", state: { input: { questions: [{ question: "The upstream technical baseline is missing. Who supplies it?" }] }, error: { type: "aborted", message: "Tool execution interrupted" } } }] },
      { id: promptId, type: "user" },
    ], cursor: {} } };
    return undefined;
  });
  await assert.rejects(runtime.run({ directory: "/project", mode: "build", prompt: "Recover Worker" }), error => {
    assert(error instanceof OpenCodeError);
    assert.equal(error.sessionId, sessionId);
    assert.equal(error.kind, "interrupted");
    assert.match(error.message, /upstream technical baseline is missing/);
    assert(!error.message.includes("No error details supplied"));
    return true;
  });
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/prompt")).length, 1);
});


test("structured replies spanning assistant messages retain their complete schema and never use an orphaned tail", async t => {
  const first = '{"groups":[{"reevaluateWhen":[';
  const last = '"If the user later requests touch input, reassess."]}]}';
  const { runtime } = await fixture(t, call => call.url.pathname.endsWith("/message") ? { body: { data: [
    { id: "msg_idle", type: "idle", outcome: "succeeded" },
    { id: "msg_tail", type: "assistant", content: [{ type: "text", text: last }] },
    { id: "msg_start", type: "assistant", content: [{ type: "text", text: first }] },
    { id: promptId, type: "user" },
    { id: "msg_old", type: "assistant", content: [{ type: "text", text: '{"groups":["old request"]}' }] },
  ], cursor: {} } } : undefined);
  const reply = await runtime.run({ directory: "/project", mode: "judge", prompt: "Consolidate", resultKeys: ["groups"] });
  assert.deepEqual(JSON.parse(reply.text), { groups: [{ reevaluateWhen: ["If the user later requests touch input, reassess."] }] });
});
