import assert from "node:assert/strict";
import test from "node:test";
import { BrowserConversation } from "../src/conversation.js";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectInputQueue } from "../src/input-queue.js";

test("queued workflow feedback appears immediately and is consumed once in order", async () => {
  const controller = new AbortController();
  const io = new BrowserConversation(controller.signal);
  io.hide(["fixture-secret"]);
  io.enqueue("Use a red background");
  io.enqueue("Avoid echoing fixture-secret");
  assert.equal(io.queued, 2);
  assert.deepEqual(io.messages.map(message => message.role), ["user", "user"]);
  assert.equal(io.messages[1]?.text, "Avoid echoing [hidden]");
  assert.equal(io.takeInput(), "Use a red background");
  assert.equal(await io.ask("Additional requirements?"), "Avoid echoing fixture-secret");
  assert.equal(io.prompt, undefined);
  assert.equal(io.queued, 0);
  assert.equal(io.takeInput(), undefined);
  assert.equal(io.messages.length, 2, "dequeueing never adds a second user message");
});

test("a secret prompt preserves queued project feedback until a normal stage boundary", async () => {
  const io = new BrowserConversation(new AbortController().signal);
  io.enqueue("Add keyboard support");
  const pending = io.secret("API key");
  assert.equal(io.prompt?.secret, true);
  assert.equal(io.queued, 1);
  io.answer(io.prompt!.id, "fixture-api-key");
  assert.equal(await pending, "fixture-api-key");
  assert.equal(io.takeInput(), "Add keyboard support");
  assert(!JSON.stringify(io.messages).includes("fixture-api-key"));
});

test("queue admission is bounded and refuses closed or aborted conversations", () => {
  const controller = new AbortController();
  const io = new BrowserConversation(controller.signal);
  assert.throws(() => io.enqueue("  "), /请输入/);
  assert.throws(() => io.enqueue("x".repeat(16_001)), /消息过长/);
  for (let index = 0; index < 32; index++) io.enqueue(`Requirement ${index}`);
  assert.throws(() => io.enqueue("overflow"), /待处理消息已满/);
  assert.equal(io.messages.length, 32);
  controller.abort();
  assert.equal(io.queued, 0);
  assert.equal(io.takeInput(), undefined);
  assert.throws(() => io.enqueue("too late"), /交互已结束/);
  assert.equal(io.messages.length, 32);
});

test("queued recovery input clears the visible failure without creating a stale prompt", async () => {
  const io = new BrowserConversation(new AbortController().signal);
  io.error("temporary failure");
  io.enqueue("Retry the current task");
  assert.equal(await io.ask("Retry?"), "Retry the current task");
  assert.equal(io.failure, undefined);
  assert.equal(io.prompt, undefined);
});

test("accepted feedback survives pause and process reconstruction until an explicit successful acknowledgement", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = new ProjectInputQueue(directory);
  await queue.load();
  const controller = new AbortController();
  const io = new BrowserConversation(controller.signal, queue);
  await io.enqueue("Add keyboard support next");
  const persisted = JSON.parse(await readFile(queue.file, "utf8"));
  assert.equal(persisted.entries[0].text, "Add keyboard support next");
  assert.equal((await stat(queue.file)).mode & 0o777, 0o600);
  assert.equal(io.takeInput(), "Add keyboard support next");
  const id = io.inputID;
  assert.equal(io.takeInput(), undefined, "an in-flight failure cannot be consumed again implicitly");
  controller.abort();
  const restored = new ProjectInputQueue(directory);
  await restored.load();
  const next = new BrowserConversation(new AbortController().signal, restored);
  assert.equal(next.queued, 1);
  assert.equal(next.messages.filter(message => message.role === "user").length, 1);
  assert.equal(next.takeInput(), "Add keyboard support next");
  assert.equal(next.inputID, id);
  await next.completeInput();
  assert.equal(next.queued, 0);
  const after = new ProjectInputQueue(directory);
  await after.load();
  assert.equal(after.peek(), undefined);
});

test("durable queue serialization preserves concurrent accepted inputs and acknowledges only the head", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-input-order-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = new ProjectInputQueue(directory);
  const entries = await Promise.all([queue.enqueue("first"), queue.enqueue("second"), queue.enqueue("third")]);
  assert.deepEqual(queue.entries.map(entry => entry.text), ["first", "second", "third"]);
  await assert.rejects(queue.complete(entries[1]!.id), /按提交顺序/);
  await queue.complete(entries[0]!.id);
  await queue.complete(entries[0]!.id);
  const restored = new ProjectInputQueue(directory);
  await restored.load();
  assert.deepEqual(restored.entries.map(entry => entry.text), ["second", "third"]);
});

test("durable feedback cannot follow a project-private path symlink into another folder", async t => {
  const directory = await mkdtemp(join(tmpdir(), "openagi-input-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "openagi-input-outside-"));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, "input-queue.json"), "outside sentinel");
  await mkdir(join(directory, ".openagi"));
  await symlink(join(outside, "input-queue.json"), join(directory, ".openagi", "input-queue.json"));
  const queue = new ProjectInputQueue(directory);
  await assert.rejects(queue.load(), /超出当前项目/);
  await assert.rejects(queue.enqueue("new feedback"), /超出当前项目/);
  assert.equal(await readFile(join(outside, "input-queue.json"), "utf8"), "outside sentinel");
});
