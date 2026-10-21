import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { DEFAULT_PROXY, applyNetworkProfile, readNetworkProfile, saveNetworkProfile } from "../src/network-profile.js";
import { configureOutboundProxy } from "../src/proxy.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "openagi-network-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
test("network settings default to local 7892, migrate existing configuration and persist explicit disable", async t => {
  const directory = await fixture(t);
  assert.deepEqual(await readNetworkProfile(directory), { enabled: true, proxyURL: DEFAULT_PROXY, noProxy: "localhost,127.0.0.1,::1" });
  await writeFile(join(directory, "network.json"), JSON.stringify({ httpsProxy: "http://127.0.0.1:8888", noProxy: "LOCALHOST,internal.test" }));
  const migrated = await readNetworkProfile(directory);
  assert.equal(migrated.proxyURL, "http://127.0.0.1:8888"); assert.equal(migrated.noProxy, "LOCALHOST,internal.test,127.0.0.1,::1");
  const saved = await saveNetworkProfile({ ...migrated, enabled: false, proxyURL: DEFAULT_PROXY }, directory);
  assert.deepEqual(await readNetworkProfile(directory), saved);
  assert.equal(JSON.parse(await readFile(join(directory, "network.json"), "utf8")).httpsProxy, "");
  if (process.platform !== "win32") assert.equal((await stat(join(directory, "network.json"))).mode & 0o777, 0o600);
});
test("invalid proxy settings preserve the existing file", async t => {
  const directory = await fixture(t); const initial = await saveNetworkProfile({ enabled: true, proxyURL: DEFAULT_PROXY, noProxy: "" }, directory);
  for (const proxyURL of ["socks5://127.0.0.1:7892", "http://username:secret@127.0.0.1:7892", "http://127.0.0.1:7892/path", "invalid"]) await assert.rejects(saveNetworkProfile({ ...initial, proxyURL }, directory));
  assert.deepEqual(await readNetworkProfile(directory), initial);
});
test("real fetch uses the selected proxy for external hosts, bypasses localhost and stops using it after disable", async t => {
  const original = { ...process.env };
  t.after(async () => { for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } configureOutboundProxy(original); });
  let connections = 0;
  const proxy = createServer();
  proxy.on("connect", (_request, socket) => { connections++; socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { proxy.closeAllConnections(); proxy.close(() => resolve()); }));
  const address = proxy.address(); assert(address && typeof address !== "string");
  const local = createServer((_request, response) => response.end("local"));
  await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { local.closeAllConnections(); local.close(() => resolve()); }));
  const localAddress = local.address(); assert(localAddress && typeof localAddress !== "string");
  const profile = { enabled: true, proxyURL: `http://127.0.0.1:${address.port}`, noProxy: "" };
  applyNetworkProfile(profile);
  await assert.rejects(fetch("https://external.invalid", { signal: AbortSignal.timeout(3000) }));
  assert(connections > 0, "The actual HTTPS request reaches the proxy CONNECT listener");
  const before = connections;
  assert.equal(await fetch(`http://127.0.0.1:${localAddress.port}`).then(response => response.text()), "local"); assert.equal(connections, before);
  applyNetworkProfile({ ...profile, enabled: false });
  await assert.rejects(fetch("https://external.invalid", { signal: AbortSignal.timeout(3000) }));
  assert.equal(connections, before, "Disable must replace the existing global dispatcher");
});
