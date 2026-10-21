import test from "node:test";
import assert from "node:assert/strict";
import { smokeNativeClient } from "../scripts/smoke-native-client.js";

test("optional native client receives real reasoning and tool execution events from the isolated original v2 backend", { skip: process.env.OPENAGI_NATIVE_SMOKE !== "1" }, async () => {
  const result = await smokeNativeClient(); assert.equal(result.reasoningPersisted, true); assert.equal(result.originalReadTool, "passed"); assert.equal(result.externalModelCalls, 0);
  assert.equal(result.pauseClaimReleased, true); assert.equal(result.foregroundRestartResumeCalls, 0);
  assert.equal(result.nativeLocalEndpointOwnership, "verified");
  assert.equal(result.nativeProcessCleanup, "verified");
});
