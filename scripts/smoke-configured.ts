import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { configuredBackend } from "../src/backend.js";
import { Settings } from "../src/settings.js";

/** A real isolated OpenCode engine backed by a loopback fixture LLM: no paid/external model calls. */
export async function smokeConfigured(directory = process.cwd()) {
  const calls: { model: string; authorized: boolean; path: string }[] = [];
  let probe = false; let sentToolCall = false; let deniedRead = false;
  const fixture = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ model: input.model, authorized: request.headers.authorization === "Bearer fixture-header-key" && request.headers["x-openagi-auth"] === "fixture-secondary-key", path: request.url! });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "fixture-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: input.model };
    if (probe && !sentToolCall) {
      const read = input.tools?.find((tool: { function?: { name?: string } }) => tool.function?.name?.endsWith("read"));
      assert(read, "The original OpenCode read tool must remain available");
      sentToolCall = true;
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "fixture-outside-read", type: "function", function: { name: read.function.name, arguments: JSON.stringify({ path: resolve(directory, "..", "outside-project-fixture.txt") }) } }] }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
      response.end("data: [DONE]\n\n"); return;
    }
    if (probe) deniedRead = JSON.stringify(input.messages?.filter((message: { role: string }) => message.role === "tool")).includes("outside current project");
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "fixture-response" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(ready => fixture.listen(0, "127.0.0.1", ready));
  const address = fixture.address(); assert(address && typeof address === "object");
  const settings = Settings.parse({ version: 2, providers: { owned: { type: "openai-compatible", baseURL: `http://127.0.0.1:${address.port}/v1`, headers: { Authorization: "Bearer fixture-header-key", "x-openagi-auth": "fixture-secondary-key" }, models: [{ id: "fixture-model" }, { id: "fixture-light" }] } }, models: { heavy: { providerID: "owned", modelID: "fixture-model" }, light: { providerID: "owned", modelID: "fixture-light" } }, jev: { type: "typesafe", apiKey: "fixture-typesafe-key" } });
  let backend: Awaited<ReturnType<typeof configuredBackend>> | undefined;
  try {
    backend = await configuredBackend(directory, { file: resolve(directory, ".openagi/config.json"), settings, keys: { owned: undefined }, jevKey: "fixture-typesafe-key" }, { onProgress: message => console.error(message) });
    const reply = await backend.runtime.run({ directory, mode: "observe", model: settings.models.heavy, prompt: "Reply exactly fixture-response; do not use tools." });
    assert.equal(reply.text, "fixture-response"); assert(calls.length > 0);
    const judged = await backend.runtime.run({ directory, mode: "observe", model: settings.models.light, prompt: "Reply exactly fixture-response; do not use tools." });
    assert.equal(judged.text, "fixture-response");
    assert(calls.every(call => call.authorized && ["fixture-model", "fixture-light"].includes(call.model)));
    assert(calls.some(call => call.model === "fixture-light"));
    probe = true;
    const protectedReply = await backend.runtime.run({ directory, mode: "observe", model: settings.models.heavy, prompt: "Use the requested read tool once, then reply fixture-response." });
    assert.equal(protectedReply.text, "fixture-response"); assert(deniedRead, "A read outside the project must fail before accessing the filesystem");
    return { isolatedBackend: "passed", providerSource: "OpenAGI configuration", projectGuard: "active", outsideRead: "blocked", models: ["fixture-model", "fixture-light"], fixtureRequests: calls.length, paidModelCalls: 0 };
  } finally {
    await backend?.server.close(); fixture.closeAllConnections(); await new Promise<void>(done => fixture.close(() => done()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await smokeConfigured(), null, 2));
