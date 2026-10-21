import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OpenCodeError, OpenCodeRuntime } from "../src/opencode.js";

/** Exercises real v2 transport without admitting a prompt or calling a model. */
export async function smokeOpenCode(options: { url: string; password?: string; directory?: string }) {
  const base = options.url.replace(/\/$/, "");
  const headers = new Headers({ "content-type": "application/json" });
  if (options.password) headers.set("authorization", `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`);
  const directory = resolve(options.directory ?? process.cwd());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `Live OpenCode ${method} ${path} returned ${response.status}`);
    return response.status === 204 ? undefined : response.json() as Promise<unknown>;
  };
  const info = z.object({ version: z.string().startsWith("2.") }).parse(await call("GET", "/api/info"));
  const query = new URLSearchParams({ "location[directory]": directory });
  const providers = z.object({ data: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await call("GET", `/api/websearch/provider?${query}`));
  let sessionId: string | undefined;
  try {
    // Run the actual adapter through creation, but reject prompt transport locally.
    // This tests adapter authentication, version and creation without paid generation.
    const runtime = new OpenCodeRuntime({
      baseUrl: options.url, password: options.password,
      fetch: async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/prompt")) throw new Error("Live smoke intentionally stops before prompt admission");
        return fetch(input, init);
      },
    });
    await assert.rejects(runtime.run({ directory, mode: "observe", prompt: "Never transmitted" }), (error: unknown) => {
      assert(error instanceof OpenCodeError);
      assert.equal(error.kind, "transport");
      assert(error.sessionId);
      assert.match(error.message, /stops before prompt admission/);
      sessionId = error.sessionId;
      return true;
    });
    assert(sessionId);
    const path = `/api/session/${encodeURIComponent(sessionId)}`;
    const session = z.object({ data: z.object({ id: z.string(), location: z.object({ directory: z.string() }), permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect: z.string() })) }) }).parse(await call("GET", path));
    assert.equal(session.data.location.directory, directory);
    assert.equal(session.data.permissions[0]?.effect, "deny");
    await call("PATCH", path, { permissions: session.data.permissions });
    const permissions = z.object({ data: z.array(z.unknown()) }).parse(await call("GET", `${path}/permission`));
    const forms = z.object({ data: z.array(z.unknown()) }).parse(await call("GET", `${path}/form`));
    assert.equal(permissions.data.length, 0); assert.equal(forms.data.length, 0);
    const messages = z.object({ data: z.array(z.object({ type: z.string() })), cursor: z.object({ next: z.string().nullish(), previous: z.string().nullish() }) }).parse(await call("GET", `${path}/message?limit=200&order=desc`));
    assert(!messages.data.some((message) => ["user", "assistant"].includes(message.type)));
    await call("POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`);
    const active = z.object({ data: z.record(z.string(), z.unknown()) }).parse(await call("GET", "/api/session/active"));
    assert.equal(active.data[sessionId], undefined);
    return { version: info.version, providers: providers.data.map((provider) => provider.id), sessionContract: "passed", promptAdmission: "not executed", modelCalls: 0 };
  } finally {
    if (sessionId) await call("DELETE", `/api/session/${encodeURIComponent(sessionId)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const url = process.env.OPENAGI_LIVE_URL;
  if (!url) throw new Error("Set OPENAGI_LIVE_URL to a temporary OpenCode v2 service");
  console.log(JSON.stringify(await smokeOpenCode({ url, password: process.env.OPENAGI_LIVE_PASSWORD, directory: process.env.OPENAGI_LIVE_DIRECTORY }), null, 2));
}
