import assert from "node:assert/strict";
import test from "node:test";
import { answerOpenCode, SessionStopped } from "../src/interactions.js";
import { runChecks } from "../src/workspace.js";

test("permission requests require explicit consent and return a per-request decision", async () => {
  const answers = ["", "y", "n"];
  const replies = await answerOpenCode({ write() {}, async ask() { return answers.shift() ?? null; } }, {
    sessionId: "ses_test", permissions: [{ id: "per_read", action: "shell", resources: ["npm test"] }, { id: "per_edit", action: "edit", resources: ["file.ts"] }], forms: [],
  });
  assert.deepEqual(replies, [{ kind: "permission", id: "per_read", decision: "once" }, { kind: "permission", id: "per_edit", decision: "reject" }]);
});

test("forms support typed answers, defaults, options and conditional fields in the same terminal", async () => {
  const answers = ["2", "3.2", "4", "1,2", "n"];
  const replies = await answerOpenCode({ write() {}, async ask() { return answers.shift() ?? null; } }, {
    sessionId: "ses_test", permissions: [], forms: [{ id: "frm_test", title: "配置", fields: [
      { key: "mode", type: "string", required: true, options: [{ label: "简单", value: "simple" }, { label: "完整", value: "full" }] },
      { key: "count", type: "integer", minimum: 1, maximum: 10, required: true },
      { key: "parts", type: "multiselect", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], minItems: 2 },
      { key: "enabled", type: "boolean", required: true },
      { key: "conditional", type: "string", required: true, when: [{ key: "enabled", op: "eq", value: true }] },
      { key: "hidden", type: "string", hidden: true, default: "default" },
    ] }],
  });
  assert.deepEqual(replies, [{ kind: "form", id: "frm_test", answer: { mode: "full", count: 4, parts: ["a", "b"], enabled: false, hidden: "default" } }]);
});

test("EOF pauses pending interactions without granting permission", async () => {
  await assert.rejects(answerOpenCode({ write() {}, async ask() { return null; } }, { sessionId: "ses_test", permissions: [{ id: "per_test", action: "shell" }], forms: [] }), SessionStopped);
});

test("abort cancels an active configured check rather than waiting for its timeout", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const before = Date.now();
  const checks = await runChecks(process.cwd(), [{ name: "long", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 30_000 }], controller.signal);
  assert.equal(checks[0]?.ok, false); assert.match(checks[0]!.stderr, /cancelled/);
  assert(Date.now() - before < 5_000);
});
