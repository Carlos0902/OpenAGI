import test from "node:test";
import assert from "node:assert/strict";
import { smokeOpenCode } from "../scripts/smoke-opencode.js";

test("optional live OpenCode v2 health/session contract without model calls", { skip: !process.env.OPENAGI_LIVE_URL }, async () => {
  const result = await smokeOpenCode({ url: process.env.OPENAGI_LIVE_URL!, password: process.env.OPENAGI_LIVE_PASSWORD, directory: process.env.OPENAGI_LIVE_DIRECTORY });
  assert.equal(result.sessionContract, "passed");
  assert.equal(result.modelCalls, 0);
});
