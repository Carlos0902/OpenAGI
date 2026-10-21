import assert from "node:assert/strict";
import test from "node:test";
import { typesafeJudgement, validateTypesafeKey, TypesafeHTTPError, TYPESAFE_BASE_URL, TYPESAFE_MODEL } from "../src/typesafe.js";
import { Judgement } from "../src/domain.js";
import { Collector } from "../src/tutor.js";
import { ProjectConfig } from "../src/domain.js";
import type { AgentRuntime, AgentRequest } from "../src/runtime.js";

const proposal = { title: "改善流程", description: "Implement the requested feature", evidence: [{ location: "src/app.ts", observation: "Missing feature" }], acceptanceCriteria: ["Feature works"], questions: [] };
const request: AgentRequest = { directory: "/project", mode: "judge", prompt: "evaluate", purpose: "collector", evaluation: { context: { goal: "Feature" }, candidates: [{ id: "one", proposal }], archiveNecessityBelow: 2, reopen: false } };
const draft = () => ({ groups: [{ candidateIds: ["one"], proposal, rationale: "The supplied evidence supports this scope", reevaluateWhen: [] }] });
const delegate: AgentRuntime = { async run(request) { assert.equal(request.purpose, undefined); assert.equal(request.model?.modelID, "heavy"); return { sessionId: "ses_draft", text: JSON.stringify(draft()) }; }, async search() { return []; } };
function questionDelegate(questions: unknown[]): AgentRuntime {
  return { async run(request) {
    assert.match(request.prompt, /Unrequested learning purpose, optional tutorials/);
    return { sessionId: "draft", text: JSON.stringify({ groups: [{ ...draft().groups[0], proposal: { ...proposal, questions } }] }) };
  }, async search() { return []; } };
}

function fixtureFetch(scores: Record<string, number> = {}, decision = 0.1, questionDecisions: Record<string, number> = {}): typeof fetch {
  return async (input, options) => {
    assert.equal(String(input), `${TYPESAFE_BASE_URL}/systemone`);
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer user-typesafe-key");
    const body = JSON.parse(String(options?.body)); assert.equal(body.model, TYPESAFE_MODEL); assert.equal(Object.keys(body.questions).length, 6 + body.state.groups[0].proposal.questions.length);
    assert.equal(body.state.groups[0].assessment, undefined, "LLM provisional scores must not bias typed evaluation");
    assert(body.state.groups[0].proposal.questions.every((question: { blocking?: boolean; decisionRequiredProbability?: number }) => question.blocking === undefined && question.decisionRequiredProbability === undefined), "provisional question flags and old probabilities must not bias Jev");
    const answers = Object.fromEntries(Object.entries(body.questions).map(([name, q]) => {
      if ((q as { type: string }).type === "noul") return [name, { type: "noul", noul: questionDecisions[name] ?? decision }];
      return [name, { type: "score", score: scores[name] ?? 4.2, confidence: 0.9, legend: { "0": "low", "5": "high" }, probabilities: { "4": 0.8, "5": 0.2 } }];
    }));
    return new Response(JSON.stringify({ model: "jev-resolved-version", answers, usage: { input_tokens: 100, output_tokens: 6 } }), { headers: { "content-type": "application/json" } });
  };
}

test("TypeSafe scores overwrite no LLM scores, preserve fractional decisions and attach evaluation provenance", async () => {
  const reply = await typesafeJudgement(request, delegate, { providerID: "primary", modelID: "heavy" }, "user-typesafe-key", undefined, fixtureFetch());
  const result = Judgement.parse(JSON.parse(reply.text)); const assessment = result.groups[0]!.assessment;
  assert.equal(assessment.necessity, 4.2); assert.equal(assessment.userDecisionRequired, false);
  assert.equal(assessment.jev?.source, "typesafe"); assert.equal(assessment.jev?.model, "jev-resolved-version");
});

test("low necessity preserves archive conditions, while low clarity alone never invents questions", async () => {
  const reply = await typesafeJudgement(request, delegate, { providerID: "primary", modelID: "heavy" }, "user-typesafe-key", undefined, fixtureFetch({ g0_necessity: 1.2, g0_requirementClarity: 2.2 }, 0.8));
  const group = Judgement.parse(JSON.parse(reply.text)).groups[0]!;
  assert(group.assessment.archiveReason); assert(group.assessment.reevaluateWhen.length);
  assert.equal(group.assessment.userDecisionRequired, false); assert.equal(group.proposal.questions.length, 0);
});

test("a TypeSafe failure cannot fall back to a normal LLM or another endpoint", async () => {
  await assert.rejects(typesafeJudgement(request, delegate, { providerID: "primary", modelID: "heavy" }, "key", undefined, async input => {
    assert.equal(String(input), `${TYPESAFE_BASE_URL}/systemone`); return new Response("Unauthorized", { status: 401 });
  }), /不会改用其他来源或 LLM/);
});

test("incomplete typed answers fail rather than inventing missing ratings", async () => {
  const recorded: unknown[] = [];
  await assert.rejects(typesafeJudgement(request, delegate, { providerID: "primary", modelID: "heavy" }, "key", undefined, async () => new Response(JSON.stringify({ model: TYPESAFE_MODEL, answers: {}, usage: { input_tokens: 100, output_tokens: 0 } })), undefined, async (model, usage) => { recorded.push({ model, usage }); }), /不完整/);
  assert.deepEqual(recorded, [{ model: TYPESAFE_MODEL, usage: { input_tokens: 100, output_tokens: 0 } }], "returned usage is recorded even when evaluation validation fails");
});

test("the learning-purpose question and routine implementation choices do not block a playable game", async () => {
  const questions = [
    { id: "learning", question: "是否为了学习编程，需要额外教学讲解？", blocking: true, decisionRequiredProbability: 0.99, defaultDecision: "先交付可玩的游戏，提供简明运行说明；教学讲解作为后续可选项。" },
    { id: "size", question: "棋盘大小和移动速度是多少？", defaultDecision: "棋盘尺寸和速度采用常规值，并集中为可调整参数。", answer: "fabricated" },
    { id: "core", question: "离线本机应用还是现有服务中的多人联网游戏？" },
  ];
  const reply = await typesafeJudgement(request, questionDelegate(questions), { providerID: "primary", modelID: "heavy" }, "user-typesafe-key", undefined, fixtureFetch({ g0_requirementClarity: 2.2 }, 0.9, { g0_q0_blocking: 0.35, g0_q1_blocking: 0.7, g0_q2_blocking: 0.92 }));
  const group = Judgement.parse(JSON.parse(reply.text)).groups[0]!;
  assert.equal(group.proposal.questions[0]?.blocking, false); assert.equal(group.proposal.questions[1]?.blocking, false);
  assert.equal(group.proposal.questions[2]?.blocking, true); assert.equal(group.assessment.userDecisionRequired, true);
  assert.equal(group.proposal.assumptions?.length, 2); assert(group.proposal.assumptions?.[0]?.includes("后续可选"));
  assert(group.proposal.questions.every(question => question.answer === undefined));
});

test("new questions after human answers must meet the stricter follow-up threshold", async () => {
  const question = { id: "platform", question: "在哪个平台使用？", answer: "电脑浏览器、WASD、本机自己玩" };
  const following = [{ id: "platform-again", question: question.question }, { id: "learning", question: "是否希望学习编程？" }, { id: "permission", question: "是否授权必要的不可逆迁移？" }];
  const withAnswers: AgentRequest = { ...request, evaluation: { ...request.evaluation!, candidates: [{ id: "one", proposal: { ...proposal, questions: [question] }, existing: { questions: [question] } }] } };
  const reply = await typesafeJudgement(withAnswers, questionDelegate(following), { providerID: "primary", modelID: "heavy" }, "user-typesafe-key", undefined, fixtureFetch({}, 0.99, { g0_q0_blocking: 0.99, g0_q1_blocking: 0.94, g0_q2_blocking: 0.97 }));
  const group = Judgement.parse(JSON.parse(reply.text)).groups[0]!;
  assert.equal(group.proposal.questions[0]?.blocking, false, "already answered question stays resolved even if the score is high");
  assert.equal(group.proposal.questions[1]?.blocking, false, "follow-up below .95 is optional");
  assert.equal(group.proposal.questions[2]?.blocking, true, "real critical blockers are retained");
  assert.equal(group.assessment.jev?.clarification?.followupDecisionThreshold, 0.95);
});

test("individually optional questions can become a ready task without fabricating user answers", async () => {
  const reply = await typesafeJudgement(request, questionDelegate([{ id: "learning", question: "是否希望学习编程？" }]), { providerID: "primary", modelID: "heavy" }, "user-typesafe-key", undefined, fixtureFetch({ g0_requirementClarity: 2.2 }, 0.99, { g0_q0_blocking: 0.6 }));
  const project = ProjectConfig.parse({ name: "game", directory: "/project", context: { goal: "贪吃蛇" }, modules: ["function-finder"], opencode: {}, validation: { checks: [], requireChecks: false } });
  const runtime: AgentRuntime = { async run() { return reply; }, async search() { return []; } };
  const [task] = await new Collector(runtime).collect(project, [{ id: "one", modules: ["function-finder"], proposal }]);
  assert.equal(task?.status, "ready"); assert.equal(task?.questions[0]?.answer, undefined);
  assert.equal(task?.questions[0]?.blocking, false); assert(task?.assumptions?.length);
});

test("regional restrictions are not misreported as invalid credentials and never expose response secrets", async () => {
  const key = "fixture-secret-key";
  await assert.rejects(validateTypesafeKey(key, undefined, async () => new Response(JSON.stringify({ title: "Typesafe is not available in your region.", reflected: key }), { status: 451, headers: { "cf-ray": "abc123-HKG" } })), (error: unknown) => {
    assert(error instanceof TypesafeHTTPError);
    assert.equal(error.status, 451);
    assert.match(error.message, /地区/); assert.match(error.message, /不是 API key 校验结果/);
    assert.match(error.message, /abc123-HKG/); assert(!error.message.includes(key));
    return true;
  });
});

test("TypeSafe errors distinguish authentication, permission, rate limit and service failures", async () => {
  for (const [status, message] of [[401, /拒绝了认证/], [403, /账号权限/], [429, /限流/], [503, /暂时不可用/]] as const) {
    await assert.rejects(validateTypesafeKey("fixture-secret-key", undefined, async () => new Response("fixture-secret-key", { status, headers: { "x-request-id": "fixture-secret-key" } })), (error: unknown) => {
      assert(error instanceof TypesafeHTTPError); assert.equal(error.status, status);
      assert.match(error.message, message); assert(!error.message.includes("fixture-secret-key")); return true;
    });
  }
});


test("authentication failure preserves consolidation evidence, reports the actual service error, and never retries model repair or executes tasks", async () => {
  let calls = 0;
  const runtime: AgentRuntime = {
    async run(input) {
      return typesafeJudgement(input, { ...delegate, async run(request) { calls++; return delegate.run(request); } }, { providerID: "primary", modelID: "heavy" }, "key", undefined, async () => new Response(null, { status: 401 }));
    }, async search() { return []; },
  };
  const project = ProjectConfig.parse({ name: "game", directory: "/project", context: { goal: "贪吃蛇" }, modules: ["function-finder"], opencode: {}, validation: { checks: [], requireChecks: false } });
  const attempts: { text: string; error?: string }[] = [];
  await assert.rejects(new Collector(runtime).collect(project, [{ id: "one", modules: ["function-finder"], proposal }], false, async attempt => { attempts.push(attempt); }), error => error instanceof TypesafeHTTPError && error.status === 401);
  assert.equal(calls, 1); assert.equal(attempts.length, 1);
  assert.deepEqual(JSON.parse(attempts[0]!.text), draft()); assert.match(attempts[0]!.error!, /HTTP 401/);
});
