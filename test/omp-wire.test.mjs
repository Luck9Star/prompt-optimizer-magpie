// omp wire-format regression (captured live on host 70, chat protocol):
// last user message content is a LIST of text parts; part 1 is an acp line +
// <system-reminder>, part 2 is an acp line + the real user text. lastUserText
// must return ONLY the user text; the wrapper lines must survive in the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastUserText } from "../lib/turn.mjs";

const body = {
  tools: [{}],
  messages: [
    { role: "user", content: [
      { type: "text", text: '<acp tokens="34" type="text" time="2026-11-21 08:17:13">m00001</acp>\n<system-reminder>\nToday: 2026-11-21; current working directory: \'/tmp\'. Do not repeat this information in your reply.\n</system-reminder>' },
      { type: "text", text: '<acp tokens="26" type="text" time="2026-11-21 08:17:13">m00002</acp>\n帮我把这个报错修一下：运行 python3 -m http.server 80 提示 Permission denied' },
    ] },
  ],
};

test("omp: array-content wrapper is stripped, only user text returned", () => {
  const lu = lastUserText(body, "chat");
  assert.ok(lu, "lastUserText must find the entry");
  assert.equal(lu.index, 0);
  assert.equal(lu.text, "帮我把这个报错修一下：运行 python3 -m http.server 80 提示 Permission denied");
});

test("omp: single-part acp+system-reminder+user still yields clean text", () => {
  const b = { messages: [{ role: "user", content: [
    { type: "text", text: '<acp tokens="1" type="text" time="2026-11-21 08:00:00">m00003</acp>\n[Replying to: "上条消息"]\n<system-reminder>x</system-reminder>\n继续刚才的修复' },
  ] }] };
  const lu = lastUserText(b, "chat");
  assert.equal(lu.text, "继续刚才的修复");
});

test("omp: pure wrapper text without user words is skipped", () => {
  const b = { messages: [{ role: "user", content: [
    { type: "text", text: '<acp tokens="1" type="text" time="2026-11-21 08:00:00">m00004</acp>\n<system-reminder>\nToday: 2026-11-21\n</system-reminder>' },
  ] }] };
  assert.equal(lastUserText(b, "chat"), undefined);
});
