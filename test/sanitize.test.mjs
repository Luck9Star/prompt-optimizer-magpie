import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";
import { mockGateway } from "./helpers.gateway.mjs";

// Local HTTP mock standing in for the gateway's /v1/chat/completions.
test("sanitize: fence stripped", async () => {
  const gw = await mockGateway({ optimize: "```\n优化后的提示词内容，足够长以通过护栏长度检查要求。\n```" });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
    const out = await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: false } });
    assert.ok(out);
    assert.deepEqual(out.messages[0].content, "优化后的提示词内容，足够长以通过护栏长度检查要求。");
  } finally { gw.close(); }
});

test("sanitize: too-short output rejected", async () => {
  const gw = await mockGateway({ optimize: "太短" });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
    assert.equal(await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: false } }), undefined);
  } finally { gw.close(); }
});

test("sanitize: too-long output rejected", async () => {
  const gw = await mockGateway({ optimize: "开头" + "很长的输出".repeat(800) });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
    assert.equal(await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: false } }), undefined);
  } finally { gw.close(); }
});

test("sanitize: blank output rejected", async () => {
  const gw = await mockGateway({ optimize: "   " });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
    assert.equal(await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: false } }), undefined);
  } finally { gw.close(); }
});

test("flow: dryRun=true records but does not rewrite", async () => {
  const gw = await mockGateway({ optimize: "一段足够长的优化后的提示词替换文本内容" });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: "帮我把这个模糊的需求优化成具体的提示词描述" }] };
    const out = await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: true } });
    assert.equal(out, undefined);
    assert.deepEqual(body.messages[0].content, "帮我把这个模糊的需求优化成具体的提示词描述");
  } finally { gw.close(); }
});

test("flow: request body to optimizer carries model/template/user原文", async () => {
  const gw = await mockGateway({ optimize: "一段足够长的优化后的提示词替换文本内容" });
  try {
    const orig = "帮我把这个模糊的需求优化成具体的提示词描述";
    const body = { tools: [{}], messages: [{ role: "user", content: orig }] };
    await onRequest(body, { protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: gw.url, deciderGroup: "", dryRun: false } });
    const seen = gw.seen.at(-1);
    assert.equal(seen.path, "/v1/chat/completions");
    assert.equal(seen.body.model, "group/prompt-optimize");
    assert.equal(seen.body.messages[0].role, "system");
    assert.ok(seen.body.messages[0].content.includes("用户提示词精准描述专家"));
    assert.ok(seen.body.messages[1].content.includes(orig));
    assert.ok(seen.body.messages[1].content.includes(JSON.stringify(orig)));
  } finally { gw.close(); }
});
