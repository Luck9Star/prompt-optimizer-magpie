import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest, replaceSpan } from "../hooks.mjs";

const HINT = "帮我看看这个报错，然后修一下";

test("span: unique verbatim hit replaces in place", () => {
  const body = { messages: [{ role: "user", content: `前缀。${HINT}。后缀` }] };
  const out = replaceSpan(body, "chat", 0, HINT, "NEW");
  assert.deepEqual(out.messages[0].content, "前缀。NEW。后缀");
  assert.equal(body.messages[0].content, `前缀。${HINT}。后缀`); // input untouched
});

test("span: multiple hits → undefined", () => {
  const body = { messages: [{ role: "user", content: `${HINT} 和 ${HINT}` }] };
  assert.equal(replaceSpan(body, "chat", 0, HINT, "NEW"), undefined);
});

test("span: zero hits → undefined", () => {
  const body = { messages: [{ role: "user", content: "别的" }] };
  assert.equal(replaceSpan(body, "chat", 0, HINT, "NEW"), undefined);
});

test("span: whitespace-normalized match when verbatim absent", () => {
  const body = { messages: [{ role: "user", content: "原文：帮我  看看\t这个报错，\n然后修一下，谢谢" }] };
  const out = replaceSpan(body, "chat", 0, HINT, "NEW");
  assert.deepEqual(out.messages[0].content, "原文：NEW，谢谢");
});

test("span: anthropic content blocks replace only text part", () => {
  const body = { messages: [{ role: "user", content: [
    { type: "text", text: "<system-reminder>x</system-reminder>" },
    { type: "text", text: HINT },
    { type: "tool_result", tool_use_id: "t", content: "keep" },
  ] }] };
  const out = replaceSpan(body, "anthropic", 0, HINT, "NEW");
  assert.deepEqual(out.messages[0].content[0].text, "<system-reminder>x</system-reminder>");
  assert.deepEqual(out.messages[0].content[1].text, "NEW");
  assert.deepEqual(out.messages[0].content[2].content, "keep");
});

test("span: gemini parts replace only text part", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "ok " }, { functionResponse: { name: "f" } }, { text: HINT }] }] };
  const out = replaceSpan(body, "gemini", 0, HINT, "NEW");
  assert.deepEqual(out.contents[0].parts[0].text, "ok ");
  assert.deepEqual(out.contents[0].parts[2].text, "NEW");
  assert.ok(out.contents[0].parts[1].functionResponse);
});

// 0.2.8 T5: the no-span verdict must come BEFORE the optimizer call.
import { mockGateway } from "./helpers.gateway.mjs";
const ctx = (url) => ({ protocol: "chat", agent: "t", kind: "", query: "", options: { gatewayUrl: url, deciderGroup: "", dryRun: false } });
const REWRITE = "这是按照专业模板改写后的完整中文提示词内容，长度足够通过护栏检查要求。";

test("span T5: text split over two content parts → no-span with zero gateway calls", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    const reports = [];
    const body = { tools: [{}], messages: [{ role: "user", content: [{ type: "text", text: "帮我把这个模糊的需求" }, { type: "text", text: "优化成具体的提示词描述" }] }] };
    const out = await onRequest(body, { ...ctx(gw.url), report: (c) => reports.push(c) });
    assert.equal(out, undefined);
    assert.equal(gw.seen.length, 0, "optimizer never called");
    assert.deepEqual(reports, ["skipped"]);
  } finally { gw.close(); }
});

test("span T5: single text part still optimizes normally", async () => {
  const gw = await mockGateway({ optimize: REWRITE });
  try {
    const body = { tools: [{}], messages: [{ role: "user", content: [{ type: "text", text: "帮我把这个模糊的需求优化成具体的提示词描述" }] }] };
    const out = await onRequest(body, ctx(gw.url));
    assert.equal(out.messages[0].content[0].text, REWRITE);
    assert.equal(gw.seen.length, 1);
  } finally { gw.close(); }
});
