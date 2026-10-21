import assert from "node:assert/strict";
import test from "node:test";
import { networkFetch, NetworkRequestError } from "../src/network.js";
import { configureOutboundProxy, proxyDescription } from "../src/proxy.js";

test("transport diagnostics distinguish refused proxy, timeout, DNS, TLS and closed connections without exposing keys", async () => {
  const codes = [["ECONNREFUSED", /连接被拒绝/], ["UND_ERR_CONNECT_TIMEOUT", /超时/], ["ENOTFOUND", /域名解析/], ["SELF_SIGNED_CERT_IN_CHAIN", /证书校验/], ["ECONNRESET", /中途关闭/]] as const;
  for (const [code, message] of codes) {
    const error = new TypeError("fetch failed reflected-fixture-key", { cause: new AggregateError([Object.assign(new Error("reflected-fixture-key"), { code })]) });
    await assert.rejects(networkFetch("https://api.typesafe.ai/v1/models", {}, "TypeSafe", async () => { throw error; }), (caught: unknown) => {
      assert(caught instanceof NetworkRequestError); assert.equal(caught.code, code); assert.match(caught.message, message);
      assert.match(caught.message, /此次未完成密钥校验/); assert(!caught.message.includes("reflected-fixture-key")); return true;
    });
  }
});
test("caller cancellation is preserved and timeout is a retriable transport error", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(networkFetch("https://api.typesafe.ai/v1/models", { signal: controller.signal }, "TypeSafe", async () => { throw controller.signal.reason; }), error => error === controller.signal.reason);
  await assert.rejects(networkFetch("https://api.typesafe.ai/v1/models", {}, "TypeSafe", async () => { throw new DOMException("fixture", "TimeoutError"); }), (error: unknown) => error instanceof NetworkRequestError && error.code === "ETIMEDOUT");
});
test("proxy diagnostic hides proxy credentials and endpoint query strings", () => {
  configureOutboundProxy({ HTTP_PROXY: "http://fixture-user:fixture-secret@127.0.0.1:7892", NO_PROXY: "localhost,127.0.0.1" });
  const message = new NetworkRequestError("TypeSafe", "ECONNREFUSED", "https://api.typesafe.ai/v1/models?key=fixture-api-key").message;
  assert.match(message, /127\.0\.0\.1:7892/);
  assert(!message.includes("fixture-user")); assert(!message.includes("fixture-secret")); assert(!message.includes("fixture-api-key"));
  assert.equal(proxyDescription("https://api.typesafe.ai/v1/models"), "已配置代理 http://127.0.0.1:7892");
});
