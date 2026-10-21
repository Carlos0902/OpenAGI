import assert from "node:assert/strict";
import { createServer } from "node:http";
import { constants, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { configuredBackend } from "../src/backend.js";
import { Settings } from "../src/settings.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { OpenCodeRuntime } from "../src/opencode.js";
import { ConfiguredRuntime } from "../src/configured-runtime.js";
import { UsageTracker } from "../src/usage.js";
import { createOpenAGIBridge, initializeOpenagiNative, ownsOpenagiServer, shutdownOpenagiNative } from "../src/upstream-bridge.js";

/** Original v2 backend, native event stream and real read tool; only loopback fixture model calls. */
export async function smokeNativeClient(executable = resolve("vendor/opencode/packages/desktop/resources/opencode-cli")) {
  const previousRoot = process.env.OPENAGI_ROOT;
  const workspace = resolve(".openagi"); await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "native-client-smoke-"));
  const binary = join(directory, ".openagi", "runtime", "bin", "opencode-cli");
  await mkdir(join(directory, ".openagi", "runtime", "bin"), { recursive: true });
  await copyFile(executable, binary, constants.COPYFILE_FICLONE);
  await writeFile(join(directory, "README.md"), "Native fixture read evidence\n");
  const calls: { authorized: boolean; toolResult: boolean }[] = [];
  const events: { type: string; data?: Record<string, unknown>; location?: { directory: string } }[] = [];
  const notifications: { sessionId: string; directory: string; mode: string }[] = [];
  const stream = new AbortController();
  let sentTool = false;
  let hold = false;
  let modelStarted: (() => void) | undefined;
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const toolResult = JSON.stringify(input.messages?.filter((message: { role: string }) => message.role === "tool")).includes("Native fixture read evidence");
    calls.push({ authorized: request.headers.authorization === "Bearer native-fixture-key", toolResult });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `native-fixture-${calls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model };
    const delta = (value: Record<string, unknown>, finish: string | null = null) => response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
    delta({ role: "assistant", reasoning_content: "Fixture reasoning visible through original events." });
    if (hold) { modelStarted?.(); return; }
    await delay(30);
    if (!sentTool) {
      const read = input.tools?.find((tool: { function?: { name?: string } }) => tool.function?.name?.endsWith("read"));
      assert(read, "Original read tool is present"); sentTool = true;
      delta({ tool_calls: [{ index: 0, id: "native-fixture-read", type: "function", function: { name: read.function.name, arguments: JSON.stringify({ path: join(directory, "README.md") }) } }] });
      await delay(30); delta({}, "tool_calls");
    } else {
      delta({ content: "native-fixture-" }); await delay(30); delta({ content: "complete" }); delta({}, "stop");
    }
    response.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 10 } } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ready => fixture.listen(0, "127.0.0.1", ready));
  const address = fixture.address(); assert(address && typeof address === "object");
  const settings = Settings.parse({ version: 2, providers: { fixture: { type: "openai-compatible", baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "native-fixture-key" } }, models: { heavy: { providerID: "fixture", modelID: "native-fixture-model" }, light: { providerID: "fixture", modelID: "native-fixture-light" } }, jev: { type: "typesafe", apiKey: "native-fixture-jev-key" } });
  const loaded = { file: join(directory, ".openagi/config.json"), settings, keys: { fixture: "native-fixture-key" }, jevKey: "native-fixture-jev-key" };
  let backend: Awaited<ReturnType<typeof configuredBackend>> | undefined;
  let bridge: Awaited<ReturnType<typeof createOpenAGIBridge>> | undefined;
  let monitor: Promise<void> | undefined;
  const awaitModel = async (started: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([started, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture model did not start")), 10_000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    const openBackend = () => configuredBackend(directory, loaded, { executable: binary, nativeInteractions: true, onSession: session => notifications.push(session) });
    backend = await openBackend();
    const response = await fetch(`${backend.server.url}/api/event`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${backend.server.password}`).toString("base64")}` }, signal: stream.signal });
    assert.equal(response.status, 200); assert(response.body);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    monitor = (async () => {
      try {
        while (!stream.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, "");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const value = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (value) events.push(JSON.parse(value));
          }
        }
      } catch (error) { if (!stream.signal.aborted) throw error; }
      finally { await reader.cancel().catch(() => {}); }
    })();
    const connected = Date.now() + 5_000;
    while (!events.some(event => event.type === "server.connected")) { assert(Date.now() < connected, "Original native event stream handshake arrives"); await delay(5); }
    const reply = await backend.runtime.run({ directory, mode: "observe", model: settings.models.heavy, label: "Native streaming fixture", prompt: "Read README.md once and then reply native-fixture-complete." });
    assert.equal(reply.text, "native-fixture-complete"); assert.equal(notifications.length, 1); assert.equal(notifications[0]?.sessionId, reply.sessionId);
    const usage = new UsageTracker(directory); await usage.load();
    assert.equal(usage.summary().error, undefined);
    assert.equal(usage.summary().total, 260, "two real native steps retain provider usage without counting cache or reasoning twice");
    assert.equal(usage.summary().models[0]?.providerID, "fixture");
    const info = z.object({ data: z.object({ title: z.string() }) }).parse(await fetch(`${backend.server.url}/api/session/${reply.sessionId}`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${backend.server.password}`).toString("base64")}` } }).then(value => value.json()));
    assert.equal(info.data.title, "Native streaming fixture", "The original native session title preserves the role label");
    const finished = Date.now() + 5_000;
    while (!events.some(event => event.type === "session.reasoning.ended") || !events.some(event => event.type === "session.tool.success")) { assert(Date.now() < finished, "Reasoning and tool events reach the original client stream"); await delay(5); }
    assert(events.some(event => event.type === "session.reasoning.delta"));
    assert(events.some(event => event.type === "session.tool.called"));
    assert(calls.every(call => call.authorized)); assert(calls.some(call => call.toolResult));
    const messages = z.object({ data: z.array(z.object({ type: z.string().optional(), metadata: z.object({ collapsed: z.boolean(), displayText: z.string() }).optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })) }).parse(await fetch(`${backend.server.url}/api/session/${reply.sessionId}/message?limit=200&order=desc`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${backend.server.password}`).toString("base64")}` } }).then(value => value.json()));
    assert(messages.data.some(message => message.type === "user" && message.metadata?.collapsed === true && message.metadata.displayText === "Native streaming fixture"), "Internal presentation metadata survives original durable prompt admission");
    assert(messages.data.some(message => message.content?.some(content => content.type === "reasoning" && content.text?.includes("Fixture reasoning"))));
    const leaseResponse = await fetch(`${backend.server.url}/api/session/${reply.sessionId}`, {
      method: "PATCH", headers: { authorization: `Basic ${Buffer.from(`opencode:${backend.server.password}`).toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { openagiInteraction: { lease: "native-lease-fixture" } } }),
    });
    assert.equal(leaseResponse.status, 204);
    const leaseDeadline = Date.now() + 5_000;
    while (!events.some(event => event.type === "session.metadata.updated" && event.location?.directory === directory)) {
      assert(Date.now() < leaseDeadline, "The real v2 metadata endpoint publishes an event scoped to the parked session's location");
      await delay(5);
    }
    const types = [...new Set(events.map(event => event.type))].filter(type => type.includes("reasoning") || type.includes("tool."));
    // Deliberate pause must release the original backend's durable execution
    // claim before process shutdown. Keep the backend alive while the runtime
    // uses an independent operation cancellation signal, just like the bridge.
    hold = true;
    const paused = new AbortController(); const pauseStarted = new Promise<void>(ready => { modelStarted = ready; });
    const native = new OpenCodeRuntime({ baseUrl: backend.server.url, password: backend.server.password, workspaceRoot: directory, signal: paused.signal, nativeInteractions: true, onSession: session => notifications.push(session), timeoutMs: 15_000 });
    const runtime = new ConfiguredRuntime(native, loaded, directory, paused.signal);
    const pauseRun = runtime.run({ directory, mode: "observe", model: settings.models.heavy, label: "Pause fixture", prompt: "Fixture pending work" });
    const pauseResult = assert.rejects(pauseRun, /Execution aborted/);
    await awaitModel(pauseStarted);
    const pausedID = notifications.at(-1)!.sessionId; paused.abort(); await pauseResult;
    const data = backend.isolation.environment.XDG_DATA_HOME!;
    const databases = (await readdir(data, { recursive: true })).filter(file => file.endsWith(".db")); assert.equal(databases.length, 1);
    const claim = (id: string) => {
      const db = new DatabaseSync(join(data, databases[0]!), { readOnly: true });
      try { return db.prepare("SELECT time_suspended FROM session_v2 WHERE id = ?").get(id) as { time_suspended: number | null }; }
      finally { db.close(); }
    };
    assert.equal(claim(pausedID).time_suspended, null, "Pause waits for the committed terminal event, releasing the execution claim");
    const afterPause = calls.length; stream.abort(); await monitor; await backend.server.close();
    backend = await openBackend(); await delay(500);
    assert.equal(calls.length, afterPause, "Restart never resumes a deliberately paused turn");

    // A raw process shutdown preserves the upstream claim. OpenAGI's official
    // foreground serve mode still must not sweep and execute it on the next boot.
    const orphanStarted = new Promise<void>(ready => { modelStarted = ready; });
    const orphan = backend.runtime.run({ directory, mode: "observe", model: settings.models.heavy, label: "Unsettled shutdown fixture", prompt: "Fixture pending work" });
    const orphanResult = assert.rejects(orphan);
    await awaitModel(orphanStarted);
    const orphanID = notifications.at(-1)!.sessionId; const beforeRestart = calls.length;
    await backend.server.close(); await orphanResult;
    assert.notEqual(claim(orphanID).time_suspended, null, "The upstream shutdown path preserves the claim for managed-server continuity");
    backend = await openBackend(); await delay(500);
    assert.equal(calls.length, beforeRestart, "Foreground project servers never auto-resume orphaned turns");
    assert.notEqual(claim(orphanID).time_suspended, null, "No synthetic recovery or replay has touched the orphaned claim");
    await backend.server.close(); backend = undefined;
    // Main's Browser/file APIs must recognize only the backend created by the
    // trusted OpenAGI bridge, not every renderer-supplied loopback endpoint.
    await writeFile(loaded.file, JSON.stringify(settings), { mode: 0o600 });
    process.env.OPENAGI_ROOT = directory;
    await initializeOpenagiNative({ cli: executable, appData: join(directory, "app-data") }); bridge = await createOpenAGIBridge(); await bridge.project(directory);
    const server = bridge.state().servers[0]; assert(server?.http); const ownedURL = server.http.url;
    const mainSessionId = bridge.state().projects[0]?.mainSessionId; assert(mainSessionId);
    assert.equal(bridge.state().sessions.find(session => session.sessionId === mainSessionId)?.mode, "workflow");
    const mainHeaders = { authorization: `Basic ${Buffer.from(`opencode:${server.http.password}`).toString("base64")}` };
    const mainInfo = await fetch(`${ownedURL}/api/session/${mainSessionId}`, { headers: mainHeaders }).then(value => value.json()) as { data: { metadata?: { openagi?: { kind?: string } } } };
    assert.equal(mainInfo.data.metadata?.openagi?.kind, "workflow");
    const mainMessages = await fetch(`${ownedURL}/api/session/${mainSessionId}/message`, { headers: mainHeaders }).then(value => value.json()) as { data: unknown[] };
    assert.deepEqual(mainMessages.data, [], "The main view never executes a model or invents tool messages");
    assert.equal(ownsOpenagiServer(server.id, ownedURL), true);
    assert.equal(ownsOpenagiServer("openagi:unregistered", ownedURL), false);
    assert.equal(ownsOpenagiServer(server.id, "http://127.0.0.1:1"), false);
    assert.equal(ownsOpenagiServer(server.id, "not a URL"), false);
    assert.equal(bridge.state().projects[0]?.phase, "idle"); assert.equal(calls.length, beforeRestart);
    await bridge.forget(directory); assert.equal(ownsOpenagiServer(server.id, ownedURL), false);
    await bridge.project(directory);
    const cleanupServer = bridge.state().servers[0]; assert(cleanupServer?.http, JSON.stringify(bridge.state().projects.map(project => ({ phase: project.phase, messages: project.messages.slice(-4) }))));
    assert.equal(bridge.state().projects[0]?.mainSessionId, mainSessionId, "Native project reopen restores the same stable workflow tab");
    assert.equal(calls.length, beforeRestart, "Restoring the workflow view makes no model calls");
    const cleanupURL = cleanupServer.http.url;
    const cleanupInfo = z.object({ pid: z.number().int().positive() }).parse(await fetch(`${cleanupURL}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${cleanupServer.http.password}`).toString("base64")}` } }).then(value => value.json()));
    assert.doesNotThrow(() => process.kill(cleanupInfo.pid, 0), "The owned fixture backend is live before native main shutdown");
    await shutdownOpenagiNative(); await shutdownOpenagiNative();
    assert.equal(bridge.closed, true);
    assert.throws(() => process.kill(cleanupInfo.pid, 0), { code: "ESRCH" }, "Native main shutdown awaits the actual owned subprocess exit");
    assert.equal(ownsOpenagiServer(cleanupServer.id, cleanupURL), false);
    await assert.rejects(createOpenAGIBridge(), /shutting down/);
    return { originalBackend: "2.0.26", nativeSession: "registered before prompt", nativeEvents: types, reasoningPersisted: true, originalReadTool: "passed", pauseClaimReleased: true, foregroundRestartResumeCalls: 0, nativeLocalEndpointOwnership: "verified", nativeProcessCleanup: "verified", externalModelCalls: 0, fixtureCalls: calls.length };
  } finally {
    if (previousRoot === undefined) delete process.env.OPENAGI_ROOT; else process.env.OPENAGI_ROOT = previousRoot;
    stream.abort(); await monitor?.catch(() => {}); await bridge?.close(); await backend?.server.close(); fixture.closeAllConnections(); await new Promise<void>(done => fixture.close(() => done())); await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await smokeNativeClient(), null, 2));
