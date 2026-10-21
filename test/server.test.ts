import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { canStartLocally, startLocalServer } from "../src/server.js";
import { OpenCodeError, OpenCodeRuntime } from "../src/opencode.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  const address = server.address(); assert(address && typeof address === "object");
  await new Promise<void>(done => server.close(() => done()));
  return address.port;
}

test("refused health connection reports the URL and structured cause instead of bare fetch failed", async () => {
  const url = `http://127.0.0.1:${await freePort()}`;
  await assert.rejects(new OpenCodeRuntime({ baseUrl: url }).check(), (error: unknown) => {
    assert(error instanceof OpenCodeError); assert.equal(error.kind, "transport");
    assert.equal(error.connection?.code, "ECONNREFUSED");
    assert.match(error.message, /没有服务在监听/); assert(error.message.includes(url)); return true;
  });
});

test("managed local backend waits for authenticated readiness and stops only its own child", async () => {
  const url = `http://127.0.0.1:${await freePort()}`;
  let password: string | undefined;
  const managed = await startLocalServer({ url, directory: process.cwd(), startupTimeoutMs: 5_000, pollIntervalMs: 20,
    launch: (hostname, port, secret) => {
      password = secret;
      return spawn(process.execPath, ["-e", `const http=require('node:http');const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.TEST_PASSWORD).toString('base64')){res.writeHead(401);res.end('{}');return;}res.end(JSON.stringify({version:'2.0.26'}));});setTimeout(()=>server.listen(Number(process.env.TEST_PORT),process.env.TEST_HOST),100);`], {
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_HOST: hostname, TEST_PORT: String(port), TEST_PASSWORD: secret },
      });
    },
  });
  assert.equal(managed.password, password);
  await new OpenCodeRuntime({ baseUrl: url, password: managed.password }).check();
  await managed.close(); await managed.close();
  await assert.rejects(new OpenCodeRuntime({ baseUrl: url }).check(), (error: unknown) => error instanceof OpenCodeError && error.connection?.code === "ECONNREFUSED");
});

test("OpenCode initialization 503 is retried until the backend is ready", async () => {
  const managed = await startLocalServer({ url: `http://127.0.0.1:${await freePort()}`, directory: process.cwd(), startupTimeoutMs: 5_000, pollIntervalMs: 20,
    launch: (hostname, port, password) => spawn(process.execPath, ["-e", `const http=require('node:http');let probes=0;http.createServer((req,res)=>{if(req.headers.authorization!=='Basic '+Buffer.from('opencode:'+process.env.TEST_PASSWORD).toString('base64')){res.writeHead(401);res.end('{}');return;}res.writeHead(++probes<=3?503:200,{'content-type':'application/json'});res.end(JSON.stringify({version:'2.0.26',pid:process.pid}));}).listen(Number(process.env.TEST_PORT),process.env.TEST_HOST);`], {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_HOST: hostname, TEST_PORT: String(port), TEST_PASSWORD: password },
    }),
  });
  try { await new OpenCodeRuntime({ baseUrl: managed.url, password: managed.password }).check(); }
  finally { await managed.close(); }
  await assert.rejects(new OpenCodeRuntime({ baseUrl: managed.url }).check(), (error: unknown) => error instanceof OpenCodeError && error.connection?.code === "ECONNREFUSED");
});

test("backend startup failure reports diagnostics and redacts its password even across log chunks", async () => {
  let password = "";
  await assert.rejects(startLocalServer({ url: `http://127.0.0.1:${await freePort()}`, directory: process.cwd(), pollIntervalMs: 20, startupTimeoutMs: 5_000,
    launch: (_host, _port, secret) => {
      password = secret;
      return spawn(process.execPath, ["-e", "process.stderr.write('password='+process.env.TEST_PASSWORD.slice(0,10));setTimeout(()=>{process.stderr.write(process.env.TEST_PASSWORD.slice(10)+'\\nstartup fixture failed');process.exit(7);},20);"], {
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEST_PASSWORD: secret },
      });
    },
  }), (error: unknown) => { assert(error instanceof Error); assert.match(error.message, /启动失败/); assert.match(error.message, /startup fixture failed/); assert(!error.message.includes(password)); return true; });
});

test("cancelled startup terminates the background child and never waits for the full startup deadline", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const before = Date.now();
  try {
    await assert.rejects(startLocalServer({ url: `http://127.0.0.1:${await freePort()}`, directory: process.cwd(), signal: controller.signal, startupTimeoutMs: 30_000,
      launch: () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }),
    }));
    assert(Date.now() - before < 5_000);
  } finally { clearTimeout(timer); }
});

test("automatic startup is restricted to loopback HTTP servers", () => {
  assert(canStartLocally("http://127.0.0.1:4096")); assert(canStartLocally("http://localhost:4096")); assert(canStartLocally("http://[::1]:4096"));
  assert(!canStartLocally("https://127.0.0.1:4096")); assert(!canStartLocally("http://example.com:4096")); assert(!canStartLocally("http://127.0.0.1:4096/proxy"));
});

test("a pinned backend already in the project cache starts directly without querying npm", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-cached-backend-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cache = join(directory, "cache"); const folder = join(cache, "_npx", "installed", "node_modules", "@opencode", "cli");
  await mkdir(join(folder, "bin"), { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.26", bin: { opencode2: "bin/opencode.exe" } }));
  await writeFile(join(folder, "bin", "opencode.exe"), `#!/usr/bin/env node\nconst http=require('node:http');const args=process.argv.slice(2);http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'2.0.26'}));}).listen(Number(args[args.indexOf('--port')+1]),args[args.indexOf('--hostname')+1]);\n`, { mode: 0o755 });
  const bin = join(directory, "test-bin"); await mkdir(bin); await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 79\n", { mode: 0o755 });
  const managed = await startLocalServer({ directory, url: `http://127.0.0.1:${await freePort()}`, environment: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, npm_config_cache: cache }, startupTimeoutMs: 5_000, pollIntervalMs: 20 });
  try { await new OpenCodeRuntime({ baseUrl: managed.url }).check(); }
  finally { await managed.close(); }
});
