import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const body = () => ({ tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] });
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, ...opts } });

test("fail-open: decider 500 → pass", async () => {
  const gw = await mockGateway({ deciderStatus: 500 });
  try {
    assert.equal(await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider" })), undefined);
    assert.equal(gw.seen.length, 1); // decider called, optimizer never reached
  } finally { gw.close(); }
});

test("fail-open: decider timeout → pass", async () => {
  const gw = await mockGateway({ hang: ["/v1/systemone"] });
  try {
    assert.equal(await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider", deciderTimeoutMs: 200 })), undefined);
  } finally { gw.close(); }
});

test("fail-open: decider followup → pass, optimizer not called", async () => {
  const gw = await mockGateway({ decider: { choice: "followup", confidence: 0.99 } });
  try {
    assert.equal(await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider" })), undefined);
    assert.equal(gw.seen.length, 1);
  } finally { gw.close(); }
});

test("fail-open: decider low confidence → pass", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.5 } });
  try {
    assert.equal(await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider" })), undefined);
    assert.equal(gw.seen.length, 1);
  } finally { gw.close(); }
});

test("flow: decider new_task≥0.6 → optimize runs and rewrites", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.8 }, optimize: "一段足够长的优化后的提示词替换文本内容" });
  try {
    const out = await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out);
    assert.deepEqual(out.messages[0].content, "一段足够长的优化后的提示词替换文本内容");
    assert.equal(gw.seen[0].path, "/v1/systemone");
    assert.equal(gw.seen[0].body.model, "group/route-decider");
    assert.ok(gw.seen[0].body.questions.noul.criteria.new_task);
    assert.equal(gw.seen[1].path, "/v1/chat/completions");
  } finally { gw.close(); }
});

test("fail-open: optimize timeout → pass, original untouched", async () => {
  const gw = await mockGateway({ hang: ["/v1/chat/completions"] });
  try {
    const b = body();
    assert.equal(await onRequest(b, ctx(gw.url, { deciderGroup: "", optimizeTimeoutMs: 200, dryRun: false })), undefined);
    assert.deepEqual(b.messages[0].content, "帮我把这个模糊的需求优化成具体的提示词描述");
  } finally { gw.close(); }
});

test("fail-open: dead gateway → pass", async () => {
  assert.equal(await onRequest(body(), ctx("http://127.0.0.1:1", { deciderGroup: "", optimizeTimeoutMs: 300 })), undefined);
});

test("fail-open: garbage JSON from decider → pass", async () => {
  const gw = await mockGateway({ deciderRaw: "not-json{" });
  try {
    assert.equal(await onRequest(body(), ctx(gw.url, { deciderGroup: "group/route-decider", optimizeTimeoutMs: 300 })), undefined);
  } finally { gw.close(); }
});
