import assert from "node:assert/strict";
import test from "node:test";
import { acceptOpenagiLaunch, createOpenAGIBridge, initializeOpenagiNative, shutdownOpenagiNative } from "../src/upstream-bridge.js";

test("closing an extension scope permits its normal reactivation before application shutdown", async () => {
  await initializeOpenagiNative({});
  const scope = new AbortController(); const before = await createOpenAGIBridge({ signal: scope.signal });
  scope.abort(); await before.close();
  const reopened = await createOpenAGIBridge();
  assert.notEqual(reopened, before); assert.equal(reopened.closed, false);
  await reopened.close();
});

test("application shutdown closes bootstrap ownership and rejects late bridge creation or launcher work", async () => {
  const bridge = await createOpenAGIBridge();
  await shutdownOpenagiNative(); await shutdownOpenagiNative();
  assert.equal(bridge.closed, true);
  await assert.rejects(createOpenAGIBridge(), /shutting down/);
  await assert.rejects(acceptOpenagiLaunch(["--project", "/must-not-be-accessed-during-shutdown"]), /shutting down/);
});
