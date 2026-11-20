import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { hasTools, opensTurn, lastUserText } from "../lib/turn.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));

test("turn: chat protocol", () => {
  const body = fx("chat");
  assert.equal(hasTools(body, "chat"), true);
  assert.equal(hasTools({ ...body, tools: [] }, "chat"), false);
  assert.equal(opensTurn(body, "chat"), true);
  const lu = lastUserText(body, "chat");
  assert.equal(lu.index, 3);
  assert.equal(lu.text, "帮我看看这个报错，然后修一下");
});

test("turn: chat last message is tool/assistant → no turn", () => {
  assert.equal(opensTurn({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }, "chat"), false);
  const lu = lastUserText({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }, "chat");
  assert.equal(lu, undefined); // trailing run stops at assistant: stale turn
});

test("turn: anthropic protocol strips system-reminder, keeps index", () => {
  const body = fx("anthropic");
  assert.equal(opensTurn(body, "anthropic"), true);
  const lu = lastUserText(body, "anthropic");
  assert.equal(lu.index, 4);
  assert.equal(lu.text, "再帮我把README改成英文，注意保留命令示例");
});

test("turn: anthropic tool_result-only user message opens no turn", () => {
  const body = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] };
  assert.equal(opensTurn(body, "anthropic"), false);
  assert.equal(lastUserText(body, "anthropic"), undefined);
});

test("turn: anthropic notification-only user message opens no turn", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", "text": "[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>agent done</task-notification>" }] }] };
  assert.equal(opensTurn(body, "anthropic"), false);
  assert.equal(lastUserText(body, "anthropic"), undefined);
});

test("turn: responses protocol skips codex environment_context", () => {
  const body = fx("responses");
  assert.equal(opensTurn(body, "responses"), true);
  const lu = lastUserText(body, "responses");
  assert.equal(lu.index, 1);
  assert.equal(lu.text, "review this repo and list the top issues");
});

test("turn: responses compaction summary is not user text", () => {
  const body = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Another language model started to solve this problem..." }] }] };
  assert.equal(opensTurn(body, "responses"), false);
  assert.equal(lastUserText(body, "responses"), undefined);
});

test("turn: gemini protocol", () => {
  const body = fx("gemini");
  assert.equal(hasTools(body, "gemini"), true);
  assert.equal(opensTurn(body, "gemini"), true);
  const lu = lastUserText(body, "gemini");
  assert.equal(lu.index, 2);
  assert.equal(lu.text, "把这个脚本改成支持并发");
});

test("turn: gemini functionResponse-only opens no turn", () => {
  const body = { contents: [{ role: "user", parts: [{ functionResponse: { name: "f" } }] }] };
  assert.equal(opensTurn(body, "gemini"), false);
  assert.equal(lastUserText(body, "gemini"), undefined);
});
