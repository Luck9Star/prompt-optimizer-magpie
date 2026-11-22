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

test("turn: billion-context resume note appended after user text is stripped", () => {
  const wire = { tools: [{}], messages: [{ role: "user", content: "回复两个字：跳过\n\n[billion-context] Your previous response ended without a tool call. Continue now: take your next concrete action — issue the tool call you were about to make, or state your final answer explicitly." }] };
  assert.equal(lastUserText(wire, "chat").text, "回复两个字：跳过");
});

test("turn: [billion-context] quoted mid-sentence stays user text", () => {
  const wire = { tools: [{}], messages: [{ role: "user", content: "我说 [billion-context] 是个工具，帮我看看" }] };
  assert.equal(lastUserText(wire, "chat").text, "我说 [billion-context] 是个工具，帮我看看");
});

test("turn: pure billion-context resume note is not user text", () => {
  const wire = { tools: [{}], messages: [{ role: "user", content: "[billion-context] Continue now: state your final answer." }] };
  assert.equal(lastUserText(wire, "chat"), undefined);
});

// opencode session-start: OpenViking memory injection (real dump shape,
// 2026-11-21 greytest, origLen=16205) — real user text sits at the END.
test("turn: chat strips openviking-context injection, keeps trailing user text", () => {
  const inj = `<openviking-context source="session-start">\n<user-profile uri="viking://user/default/memories/profile.md">\n# PROFILE\n- 有哮喘病史\n</user-profile>\n<available-memories>\n  viking://user/default/memories/\n</available-memories>\n</openviking-context>`
  const body = {
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: `<acp tokens="5.4K" type="text" time="2026-11-21 10:19:30">m00001</acp>\n${inj}\n帮我写个函数判断字符串是不是回文，用 Python，回答两行以内` },
    ],
  }
  const lu = lastUserText(body, "chat")
  assert.strictEqual(lu.text, "帮我写个函数判断字符串是不是回文，用 Python，回答两行以内")
})

// grok CLI wraps the whole user turn in <user_query>; unwrap so the
// optimizer sees the raw prompt (2026-11-21 greytest dump shape).
test("turn: chat unwraps grok <user_query> wrapper", () => {
  const body = { messages: [{ role: "user", content: "<user_query>\n帮我在 /tmp/graytest/grok2.txt 里写一句话介绍什么是幂等性\n</user_query>" }] }
  const lu = lastUserText(body, "chat")
  assert.strictEqual(lu.text, "帮我在 /tmp/graytest/grok2.txt 里写一句话介绍什么是幂等性")
})

// quoted <user_query> mid-text stays untouched
test("turn: quoted <user_query> mid-text is preserved", () => {
  const body = { messages: [{ role: "user", content: "解释 <user_query> 标签是干嘛的，两行以内" }] }
  const lu = lastUserText(body, "chat")
  assert.strictEqual(lu.text, "解释 <user_query> 标签是干嘛的，两行以内")
})

// omp composer ghost prediction rides along in first user message; strip it.
test("turn: chat strips omp <composer-prediction> ghost text", () => {
  const body = { messages: [{ role: "user", content: "<composer-prediction>帮我继续写完这段</composer-prediction>\n帮我在 /tmp 里建一个 omp 灰测文件写 hello" }] }
  const lu = lastUserText(body, "chat")
  assert.strictEqual(lu.text, "帮我在 /tmp 里建一个 omp 灰测文件写 hello")
})
