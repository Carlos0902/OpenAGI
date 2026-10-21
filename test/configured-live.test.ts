import test from "node:test";
import assert from "node:assert/strict";
import { smokeConfigured } from "../scripts/smoke-configured.js";

test("optional real isolated OpenCode uses the configured model endpoint and key through a local fixture", { skip: process.env.OPENAGI_CONFIGURED_SMOKE !== "1" }, async () => {
  const result = await smokeConfigured(); assert.equal(result.isolatedBackend, "passed"); assert.equal(result.paidModelCalls, 0);
});
