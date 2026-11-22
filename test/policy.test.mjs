import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onRequest } from "../hooks.mjs";
import { assignRollout } from "../lib/rollout.mjs";
import { readEvents } from "../lib/stats.mjs";

const decision = { answers: { noul: { choice: "new_task", confidence: 1 } } };
const output = "将这份项目交付计划整理成清晰易读的步骤。";
const body = { model: "group/batch", tools: [{}], messages: [{ role: "user", content: "整理这份项目交付计划" }] };
const decider = "/v1/systemone", optimizer = "/v1/chat/completions";

function setup(t) {
  const statsDir = mkdtempSync(join(tmpdir(), "pom-policy-"));
  t.after(() => rmSync(statsDir, { recursive: true, force: true }));
  const calls = [];
  const options = {
    gatewayUrl: "http://policy.test/" + statsDir.split("/").at(-1), statsDir,
    dryRun: false, cacheTtlMs: 0, logOptimizes: false, logSkips: false,
  };
  const ctx = { options, agent: "cli" };
  const state = { now: Date.now(), response: () => output };
  t.mock.method(Date, "now", () => state.now);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = url.endsWith(decider) ? decider : optimizer;
    calls.push(path);
    const content = state.response(path, init);
    return { ok: true, json: async () => path === decider ? decision : { choices: [{ message: { content } }] } };
  });
  return { options, ctx, calls, state, last: () => readEvents(statsDir).filter(e => e.action === "summary").at(-1) };
}

test("policy: exact selectors are ANDed, first valid match wins, unknown combinations keep global routing", async t => {
  const { ctx, options, calls, state, last } = setup(t);
  options.overrides = [
    { budgetMs: 0 }, { agent: "cli", budgetMs: -1 }, { agent: "cli", budgetMs: 1.5 },
    { agent: "cli", budgetMs: Number.MAX_SAFE_INTEGER + 1 }, { agent: "cli", optimizerMode: "invalid" },
    { agent: "CLI", budgetMs: 0 }, { model: "group/batch*", budgetMs: 0 },
    { agent: "cli", model: "other", budgetMs: 0 }, { agent: "other", model: body.model, budgetMs: 0 },
    { model: body.model, optimizerMode: "merged" }, { agent: "cli", budgetMs: 0 },
  ];
  state.response = () => "[tpl:basic]\n" + output;
  assert.ok(await onRequest(body, ctx));
  assert.deepEqual(calls, [optimizer]);
  assert.equal(last().mode, "merged");
  calls.length = 0;
  state.response = () => output;
  assert.ok(await onRequest({ ...body, model: "another" }, { ...ctx, agent: "batch" }));
  assert.deepEqual(calls, [decider, optimizer]);
  calls.length = 0;
  assert.equal(await onRequest({ ...body, model: "another" }, ctx), undefined);
  assert.deepEqual(calls, []);
  assert.equal(last().reason, "budget-exhausted");
  assert.equal(last().modelCalls, 0);
});

test("policy: thread keeps global routing and the experiment arm wins on first turns", async t => {
  const { options, ctx, state, calls, last } = setup(t);
  options.overrides = [{ agent: "cli", optimizerMode: "merged" }];
  const thread = { ...body, messages: [{ role: "assistant", content: "上一件事已完成" }, ...body.messages] };
  assert.ok(await onRequest(thread, ctx));
  assert.deepEqual(calls, [decider, optimizer]);
  assert.equal(last().turn, "thread");
  assert.equal(last().mode, "auto");
  options.rollout = { experimentId: "policy-test", agents: ["cli"], autoPercent: 40, mergedPercent: 40 };
  for (const [group, expected] of [["auto", [decider, optimizer]], ["control", []], ["merged", [optimizer]]]) {
    ctx.session = Array.from({ length: 100 }, (_, i) => String(i))
      .find(session => assignRollout(options.rollout, { ...ctx, session }, false).group === group);
    assert.ok(ctx.session);
    options.overrides[0].optimizerMode = group === "merged" ? "auto" : "merged";
    state.response = () => group === "merged" ? "[tpl:basic]\n" + output : output;
    calls.length = 0;
    await onRequest(body, ctx);
    assert.deepEqual(calls, expected);
    assert.equal(last().group, group);
  }
});

test("policy: shared remaining budget clamps both timeouts; a late decider cannot start a fallback", async t => {
  const { options, ctx, state, calls, last } = setup(t);
  options.overrides = [{ budgetMs: 30, agent: "cli", model: body.model }];
  options.deciderFallback = "merged";
  const timeout = t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  state.response = path => {
    state.now += path === decider ? 11 : 21;
    return output;
  };
  assert.equal(await onRequest(body, ctx), undefined, "late successful rewrite must pass original");
  assert.deepEqual(timeout.mock.calls.map(c => c.arguments[0]), [30, 19]);
  assert.deepEqual(calls, [decider, optimizer]);
  assert.equal(last().reason, "budget-exhausted");
  assert.equal(last().modelCalls, 2);
  for (const throws of [false, true]) {
    calls.length = 0;
    state.response = () => { state.now += 31; if (throws) throw new Error("expired"); };
    assert.equal(await onRequest(body, ctx), undefined);
    assert.deepEqual(calls, [decider]);
    assert.equal(last().reason, "budget-exhausted");
    assert.equal(last().finalAction, "pass");
    assert.equal(last().modelCalls, 1);
  }
});

test("policy: repeated deadline expiry leaves the merged breaker available for the next eligible request", async t => {
  const { options, ctx, state, last } = setup(t);
  options.overrides = [{ agent: "cli", budgetMs: 5, optimizerMode: "merged" }];
  for (let i = 0; i < 5; i++) {
    state.response = () => { state.now += 7; throw new Error("expired"); };
    assert.equal(await onRequest(body, ctx), undefined);
    assert.equal(last().reason, "budget-exhausted");
    assert.equal(last().modelCalls, 1);
  }
  state.response = () => "[tpl:basic]\n" + output;
  assert.ok(await onRequest(body, ctx));
  assert.equal(last().mode, "merged");
  assert.equal(last().reason, "merged-optimized");
});

test("policy: a shorter stage timeout keeps fallback and backend failure accounting while total budget remains", async t => {
  const { options, ctx, calls, state, last } = setup(t);
  options.overrides = [{ agent: "cli", budgetMs: 100 }];
  options.deciderFallback = "merged";
  options.deciderTimeoutMs = 5;
  options.optimizeTimeoutMs = 5;
  const stageTimeout = () => {
    state.now += 5;
    throw new DOMException("stage timed out", "TimeoutError");
  };
  state.response = path => path === decider ? stageTimeout() : "[tpl:basic]\n" + output;
  assert.ok(await onRequest(body, ctx));
  assert.deepEqual(calls, [decider, optimizer]);
  assert.equal(last().reason, "merged-optimized");
  assert.equal(last().fallbackFrom, "auto");
  options.overrides[0].optimizerMode = "merged";
  state.response = stageTimeout;
  for (let i = 0; i < 5; i++) {
    assert.equal(await onRequest(body, ctx), undefined);
    assert.equal(last().reason, "merged-fail");
  }
  state.response = () => output;
  assert.ok(await onRequest(body, ctx));
  assert.equal(last().mode, "rule");
  assert.equal(last().fallbackFrom, "merged");
});
