// Regression tests for the v4 review fixes:
//   1. the decider must receive the verbatim user text (else it just guesses);
//   2. pure-rule mode (deciderGroup="") must NOT rewrite follow-ups on a thread;
//   3. bypassModels short-circuits known machine-task models;
//   4. allowedOrigins is an optional allow-list, fail-open on a missing origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

const singleUser = (text) => ({ tools: [{}], messages: [{ role: "user", content: text }] });
const threadBody = (text) => ({
  tools: [{}],
  messages: [
    { role: "user", content: "之前的需求" },
    { role: "assistant", content: "好的，已改" },
    { role: "user", content: text },
  ],
});
const ctx = (url, opts) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, ...opts } });

test("v4: decider receives verbatim user text in state.latestUserInput", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "足够长的优化后的提示词文本内容" });
  try {
    await onRequest(singleUser("帮我设计一个限流方案"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    assert.equal(gw.seen[0].path, "/v1/systemone");
    assert.equal(gw.seen[0].body.state.latestUserInput, "帮我设计一个限流方案");
    assert.equal(gw.seen[0].body.state.hasAssistantReply, false);
  } finally { gw.close(); }
});

test("v4: decider marks hasAssistantReply=true on a thread", async () => {
  const gw = await mockGateway({ decider: { choice: "followup", confidence: 0.9 } });
  try {
    await onRequest(threadBody("帮我把这里再优化一下"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: true }));
    assert.equal(gw.seen[0].body.state.hasAssistantReply, true);
  } finally { gw.close(); }
});

test("v4: pure-rule mode passes on a thread (no decider = no follow-up rewrite)", async () => {
  const gw = await mockGateway({ optimize: "不应该被用到的文本" });
  try {
    const out = await onRequest(threadBody("帮我把这个也改一下"), ctx(gw.url, { deciderGroup: "", dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0); // neither decider nor optimizer called
  } finally { gw.close(); }
});

test("v4: pure-rule mode still optimizes a genuine first turn", async () => {
  const gw = await mockGateway({ optimize: "一段足够长的优化后的提示词替换文本" });
  try {
    const out = await onRequest(singleUser("帮我设计一个限流方案"), ctx(gw.url, { deciderGroup: "", dryRun: false }));
    assert.ok(out);
    assert.equal(out.messages[0].content, "一段足够长的优化后的提示词替换文本");
    assert.equal(gw.seen.length, 1); // optimizer only
    assert.equal(gw.seen[0].path, "/v1/chat/completions");
  } finally { gw.close(); }
});

test("v4: bypassModels short-circuits before any gateway call", async () => {
  const gw = await mockGateway({});
  try {
    const body = { ...singleUser("帮我设计一个限流方案"), model: "group/bili-summary" };
    const out = await onRequest(body, ctx(gw.url, { deciderGroup: "group/route-decider", bypassModels: ["group/bili-summary"], dryRun: false }));
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0);
  } finally { gw.close(); }
});

test("v4: allowedOrigins blocks a non-listed origin", async () => {
  const gw = await mockGateway({});
  try {
    const out = await onRequest(singleUser("帮我设计一个限流方案"), {
      protocol: "chat", agent: "t", kind: "", query: "", origin: "remote",
      options: { gatewayUrl: gw.url, deciderGroup: "", allowedOrigins: ["local"], dryRun: false },
    });
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0);
  } finally { gw.close(); }
});

test("v4: missing origin is fail-open even with an allow-list", async () => {
  const gw = await mockGateway({ optimize: "一段足够长的优化后的提示词替换文本" });
  try {
    const out = await onRequest(singleUser("帮我设计一个限流方案"), ctx(gw.url, { deciderGroup: "", allowedOrigins: ["local"], dryRun: false }));
    assert.ok(out); // origin absent → fail-open, optimization still runs
  } finally { gw.close(); }
});

test("v4: output guard lets a short prompt expand beyond 3x (up to 1500)", async () => {
  const longOut = "优化后的详细结构化提示词。" + "补充细节。".repeat(90); // ~460字, 原文6字
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: longOut });
  try {
    const out = await onRequest(singleUser("帮我设计限流"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.ok(out); // must NOT be killed by the 3x rule
    assert.ok(out.messages[0].content.length > 400);
  } finally { gw.close(); }
});

test("v4: output guard still blocks absurd expansion (>6000)", async () => {
  const gw = await mockGateway({ decider: { choice: "new_task", confidence: 0.9 }, optimize: "x".repeat(7000) });
  try {
    const out = await onRequest(singleUser("帮我设计限流"), ctx(gw.url, { deciderGroup: "group/route-decider", dryRun: false }));
    assert.equal(out, undefined); // 6000 absolute ceiling
  } finally { gw.close(); }
});
