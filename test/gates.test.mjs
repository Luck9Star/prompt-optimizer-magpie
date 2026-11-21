import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { onRequest } from "../hooks.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));
const ctx = (over) => ({ protocol: "chat", agent: "claude-code", kind: "", query: "", options: { gatewayUrl: "http://127.0.0.1:1", deciderGroup: "" }, ...over });
const HINT = "请帮我把这个报错修好，让它能正常跑起来";

test("gates: enabled=false passes", async () => {
  const body = fx("chat");
  assert.equal(await onRequest(body, ctx({ options: { enabled: false } })), undefined);
});

test("gates: subagent passes", async () => {
  assert.equal(await onRequest(fx("chat"), ctx({ kind: "subagent" })), undefined);
});

test("gates: self-loop model passes", async () => {
  assert.equal(await onRequest({ ...fx("chat"), model: "group/prompt-optimize" }, ctx()), undefined);
  assert.equal(await onRequest({ ...fx("chat"), model: "group/route-decider" }, ctx()), undefined);
});

test("gates: bypass prefix passes (query and message text)", async () => {
  assert.equal(await onRequest(fx("chat"), ctx({ query: "!!verbatim" })), undefined);
  const body = fx("chat");
  body.messages[3].content = "!!原样发送";
  assert.equal(await onRequest(body, ctx()), undefined);
});

test("gates: no tools passes when skipToolless", async () => {
  const body = fx("chat");
  delete body.tools;
  assert.equal(await onRequest(body, ctx()), undefined);
});

test("gates: short text passes", async () => {
  const body = fx("chat");
  body.messages[3].content = "继续";
  assert.equal(await onRequest(body, ctx()), undefined);
});

test("gates: overlong text passes", async () => {
  const body = fx("chat");
  body.messages[3].content = "修一下".repeat(3000);
  assert.equal(await onRequest(body, ctx()), undefined);
});

test("gates: not a turn passes (last is assistant)", async () => {
  const body = { tools: [{}], messages: [{ role: "user", content: HINT }, { role: "assistant", content: "ok" }] };
  assert.equal(await onRequest(body, ctx()), undefined);
});

test("gates: ## prefix bypasses (TUI-safe), string option still works", async () => {
  const b1 = { tools: [{}], messages: [{ role: "user", content: "##回复两个字：收到" }] };
  await onRequest(b1, { protocol: "chat", agent: "t", kind: "", query: "", options: {} });
  const b2 = { tools: [{}], messages: [{ role: "user", content: "!!回复两个字：收到" }] };
  await onRequest(b2, { protocol: "chat", agent: "t", kind: "", query: "", options: { bypassPrefix: "!!" } });
});
